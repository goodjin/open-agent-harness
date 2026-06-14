import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Session } from "."
import { getRegistry } from "@/agent/registry"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionLog } from "./log"
import { SessionStatus } from "./status"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { PartID } from "./schema"
import type { SessionID, MessageID } from "./schema"
import { MemoryStore } from "@/memory"
import { ActionResult } from "./action-result"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const PREFLIGHT_COMPACT_THRESHOLD = 3
  const RAW_LIMIT = 64 * 1024
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    const raws: Record<string, ReturnType<typeof raw>> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        const record = (level: SessionLog.Emit["level"], type: string, data: Record<string, unknown> = {}) =>
          SessionLog.emit({
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            level,
            type,
            data,
          }).catch((err) => log.warn("session log failed", { err }))
        const system = (input: LLM.StreamInput) => {
          if (input.agent.prompt || input.agent.runner === "protocol") return LLM.compose({ ...input, isCodex: false })
          return input.system
        }
        const prompt = (input: LLM.StreamInput) => {
          const systemText = system(input)
          const messages = LLM.prepareMessages(input)
          const tools =
            input.agent.runner === "protocol"
              ? [LLM.PROTOCOL_OUTPUT_TOOL]
              : [...Object.keys(input.tools), LLM.ACTION_RESULT_TOOL]
          return {
            systemBytes: systemText.length,
            systemInputCount: input.system.length,
            messageCount: messages.length,
            messageBytes: JSON.stringify(messages).length,
            user: input.user.id,
            agent: {
              name: input.agent.name,
              runner: input.agent.runner,
            },
            toolChoice: input.toolChoice,
            tools,
          }
        }
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          let failure: unknown
          try {
            let currentText: MessageV2.TextPart | undefined
            let hadTextDelta = false
            let hasOther = false
            let noTextDelta = false
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const payload = SessionLog.payloadID()
            const output = SessionLog.payloadID()
            const response = capture()
            const req = {
              ...prompt(streamInput),
              payload,
              responsePayload: output,
            }
            await record("info", "llm.start", {
              providerID: input.model.providerID,
              modelID: input.model.id,
              agent: streamInput.agent.name,
              mode: streamInput.agent.mode,
              attempt,
              messages: streamInput.messages.length,
              tools: req.tools.length,
              request: req,
            })
            if (
              await SessionCompaction.isPromptOverflow({
                system: system(streamInput),
                messages: LLM.prepareMessages(streamInput),
                model: input.model,
              })
            ) {
              await record("warn", "llm.preflight_compact", req)
              if (await shouldStopCompact(input.sessionID, streamInput.user.id)) {
                const text = [
                  "Automatic compaction was attempted multiple times, but the request is still too large for the provider.",
                  "",
                  "Start a new session for this task, or remove/truncate older messages, large tool outputs, and attachments before retrying.",
                ].join("\n")
                input.assistantMessage.error = new MessageV2.ContextOverflowError({ message: text }).toObject()
                input.assistantMessage.finish = "error"
                SessionStatus.set(input.sessionID, { type: "error", message: text })
                await record("error", "llm.compact_limit", { limit: PREFLIGHT_COMPACT_THRESHOLD, error: text })
                break
              }
              needsCompaction = true
              break
            }
            const stream = await LLM.stream({ ...streamInput, payload: { id: payload } })

            try {
              for await (const value of stream.fullStream) {
                response.add(value)
                input.abort.throwIfAborted()
                if (currentText && !["text-start", "text-delta", "text-end"].includes(value.type)) hasOther = true
                switch (value.type) {
                  case "start":
                    SessionStatus.set(input.sessionID, { type: "running" })
                    break

                  case "reasoning-start":
                    if (value.id in reasoningMap) {
                      continue
                    }
                    const reasoningPart = {
                      id: PartID.ascending(),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "reasoning" as const,
                      text: "",
                      time: {
                        start: Date.now(),
                      },
                      metadata: value.providerMetadata,
                    }
                    reasoningMap[value.id] = reasoningPart
                    await Session.updatePart(reasoningPart)
                    await record("debug", "reasoning.start", { partID: reasoningPart.id, streamID: value.id })
                    break

                  case "reasoning-delta":
                    if (value.id in reasoningMap) {
                      const part = reasoningMap[value.id]
                      part.text += value.text
                      if (value.providerMetadata) part.metadata = value.providerMetadata
                      await Session.updatePartDelta({
                        sessionID: part.sessionID,
                        messageID: part.messageID,
                        partID: part.id,
                        field: "text",
                        delta: value.text,
                      })
                    }
                    break

                  case "reasoning-end":
                    if (value.id in reasoningMap) {
                      const part = reasoningMap[value.id]
                      part.text = part.text.trimEnd()

                      part.time = {
                        ...part.time,
                        end: Date.now(),
                      }
                      if (value.providerMetadata) part.metadata = value.providerMetadata
                      await Session.updatePart(part)
                      await record("debug", "reasoning.end", {
                        partID: part.id,
                        streamID: value.id,
                        chars: part.text.length,
                        text: part.text,
                      })
                      delete reasoningMap[value.id]
                    }
                    break

                  case "tool-input-start":
                    const part = await Session.updatePart({
                      id: toolcalls[value.id]?.id ?? PartID.ascending(),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "tool",
                      tool: value.toolName,
                      callID: value.id,
                      state: {
                        status: "pending",
                        input: {},
                        raw: "",
                      },
                    })
                    toolcalls[value.id] = part as MessageV2.ToolPart
                    await record("debug", "tool.input.start", {
                      partID: part.id,
                      callID: value.id,
                      tool: value.toolName,
                    })
                    break

                  case "tool-input-delta": {
                    const match = toolcalls[value.id]
                    if (match?.state.status === "pending") {
                      match.state.raw += value.delta
                      await Session.updatePartDelta({
                        sessionID: match.sessionID,
                        messageID: match.messageID,
                        partID: match.id,
                        field: "state.raw",
                        delta: value.delta,
                      })
                    }
                    break
                  }

                  case "tool-input-end": {
                    const match = toolcalls[value.id]
                    if (match?.state.status === "pending") {
                      await record("debug", "tool.input.end", {
                        partID: match.id,
                        callID: value.id,
                        tool: match.tool,
                        ...raw(match.state.raw),
                      })
                    }
                    break
                  }

                  case "tool-call": {
                    const match = toolcalls[value.toolCallId]
                    if (match) {
                      const text = match.state.status === "pending" ? raw(match.state.raw) : raw("")
                      raws[value.toolCallId] = text
                      const part = await Session.updatePart({
                        ...match,
                        tool: value.toolName,
                        state: {
                          status: "running",
                          input: value.input,
                          time: {
                            start: Date.now(),
                          },
                        },
                        metadata: value.providerMetadata,
                      })
                      toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                      await record("info", "tool.start", {
                        partID: part.id,
                        callID: value.toolCallId,
                        tool: value.toolName,
                        input: value.input,
                        ...text,
                      })

                      const parts = await MessageV2.parts(input.assistantMessage.id)
                      const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                      if (
                        lastThree.length === DOOM_LOOP_THRESHOLD &&
                        lastThree.every(
                          (p) =>
                            p.type === "tool" &&
                            p.tool === value.toolName &&
                            p.state.status !== "pending" &&
                            JSON.stringify(p.state.input) === JSON.stringify(value.input),
                        )
                      ) {
                        const agent = await getRegistry().get(input.assistantMessage.agent)
                        if (!agent) break
                        await PermissionNext.ask({
                          permission: "doom_loop",
                          patterns: [value.toolName],
                          sessionID: input.assistantMessage.sessionID,
                          metadata: {
                            tool: value.toolName,
                            input: value.input,
                          },
                          always: [value.toolName],
                          ruleset: agent.permission,
                        })
                      }
                    }
                    break
                  }
                  case "tool-result": {
                    const match = toolcalls[value.toolCallId]
                    if (match && match.state.status === "running") {
                      await Session.updatePart({
                        ...match,
                        state: {
                          status: "completed",
                          input: value.input ?? match.state.input,
                          output: value.output.output,
                          metadata: value.output.metadata,
                          title: value.output.title,
                          time: {
                            start: match.state.time.start,
                            end: Date.now(),
                          },
                          attachments: value.output.attachments,
                        },
                      })
                      await record("info", "tool.finish", {
                        partID: match.id,
                        callID: value.toolCallId,
                        tool: match.tool,
                        title: value.output.title,
                        output: value.output.output,
                        metadata: value.output.metadata,
                      })
                      if (match.tool === ActionResult.TOOL) {
                        await record("info", "tool.action_result", {
                          partID: match.id,
                          callID: value.toolCallId,
                          tool: match.tool,
                          outcome: "success",
                          input: value.input ?? match.state.input,
                        })
                      }

                      delete raws[value.toolCallId]
                      delete toolcalls[value.toolCallId]
                    }
                    break
                  }

                  case "tool-error": {
                    const match = toolcalls[value.toolCallId]
                    if (match && (match.state.status === "running" || match.state.status === "pending")) {
                      const at = Date.now()
                      const source =
                        raws[value.toolCallId] ?? (match.state.status === "pending" ? raw(match.state.raw) : raw(""))
                      const input = value.input ?? match.state.input
                      await Session.updatePart({
                        ...match,
                        state: {
                          status: "error",
                          input,
                          error: String(value.error),
                          metadata: {
                            rawInput: source.raw,
                            rawInputBytes: source.rawBytes,
                            rawInputTruncated: source.truncated,
                            rawResponse: response.text(),
                            rawResponseBytes: response.bytes(),
                            rawResponseChars: response.chars(),
                            rawResponsePreviewChars: response.text().length,
                            rawResponseTruncated: response.truncated(),
                            responsePayload: output,
                          },
                          time: {
                            start: match.state.status === "running" ? match.state.time.start : at,
                            end: at,
                          },
                        },
                      })
                      await record("warn", "tool.error", {
                        partID: match.id,
                        callID: value.toolCallId,
                        tool: match.tool,
                        rawInput: source.raw,
                        rawInputBytes: source.rawBytes,
                        rawInputTruncated: source.truncated,
                        rawResponse: response.text(),
                        rawResponseBytes: response.bytes(),
                        rawResponseChars: response.chars(),
                        rawResponsePreviewChars: response.text().length,
                        rawResponseTruncated: response.truncated(),
                        responsePayload: output,
                        error: (value.error as Error).toString(),
                      })
                      if (match.tool === ActionResult.TOOL) {
                        await record("warn", "tool.action_result", {
                          partID: match.id,
                          callID: value.toolCallId,
                          tool: match.tool,
                          outcome: "failure",
                          input,
                          rawInput: source.raw,
                          rawInputBytes: source.rawBytes,
                          rawInputTruncated: source.truncated,
                          rawResponse: response.text(),
                          rawResponseBytes: response.bytes(),
                          rawResponseChars: response.chars(),
                          rawResponsePreviewChars: response.text().length,
                          rawResponseTruncated: response.truncated(),
                          responsePayload: output,
                          error: (value.error as Error).toString(),
                        })
                      }

                      if (
                        value.error instanceof PermissionNext.RejectedError ||
                        value.error instanceof Question.RejectedError
                      ) {
                        blocked = shouldBreak
                      }
                      delete raws[value.toolCallId]
                      delete toolcalls[value.toolCallId]
                    }
                    break
                  }
                  case "error":
                    throw value.error

                  case "start-step":
                    snapshot = await Snapshot.track()
                    const session = await Session.get(input.sessionID)
                    const step = await Session.updatePart({
                      id: PartID.ascending(),
                      messageID: input.assistantMessage.id,
                      sessionID: input.sessionID,
                      snapshot,
                      type: "step-start",
                      permission: session.permission,
                      dsl_context: session.dsl_context,
                    })
                    await record("debug", "step.start", { partID: step.id, snapshot })
                    break

                  case "finish-step":
                    const usage = Session.getUsage({
                      model: input.model,
                      usage: value.usage,
                      metadata: value.providerMetadata,
                    })
                    input.assistantMessage.finish = value.finishReason
                    input.assistantMessage.cost += usage.cost
                    input.assistantMessage.tokens = usage.tokens
                    const finish = await Session.updatePart({
                      id: PartID.ascending(),
                      reason: value.finishReason,
                      snapshot: await Snapshot.track(),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "step-finish",
                      tokens: usage.tokens,
                      cost: usage.cost,
                    })
                    await record("info", "step.finish", {
                      partID: finish.id,
                      reason: value.finishReason,
                      cost: usage.cost,
                      tokens: usage.tokens,
                    })
                    await Session.updateMessage(input.assistantMessage)
                    if (snapshot) {
                      const patch = await Snapshot.patch(snapshot)
                      if (patch.files.length) {
                        await Session.updatePart({
                          id: PartID.ascending(),
                          messageID: input.assistantMessage.id,
                          sessionID: input.sessionID,
                          type: "patch",
                          hash: patch.hash,
                          files: patch.files,
                        })
                      }
                      snapshot = undefined
                    }
                    SessionSummary.summarize({
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.parentID,
                    })
                    if (
                      !input.assistantMessage.summary &&
                      (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                    ) {
                      needsCompaction = true
                    }
                    break

                  case "text-start":
                    hadTextDelta = false
                    hasOther = false
                    currentText = {
                      id: PartID.ascending(),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "text",
                      text: "",
                      time: {
                        start: Date.now(),
                      },
                      metadata: value.providerMetadata,
                    }
                    await Session.updatePart(currentText)
                    await record("debug", "text.start", { partID: currentText.id })
                    break

                  case "text-delta":
                    if (currentText) {
                      hadTextDelta = true
                      currentText.text += value.text
                      if (value.providerMetadata) currentText.metadata = value.providerMetadata
                      await Session.updatePartDelta({
                        sessionID: currentText.sessionID,
                        messageID: currentText.messageID,
                        partID: currentText.id,
                        field: "text",
                        delta: value.text,
                      })
                    }
                    break

                  case "text-end":
                    if (currentText) {
                      currentText.text = currentText.text.trimEnd()
                      currentText.time = {
                        start: Date.now(),
                        end: Date.now(),
                      }
                      if (value.providerMetadata) currentText.metadata = value.providerMetadata
                      if (!hadTextDelta && !currentText.text && !hasOther) noTextDelta = true
                      await Session.updatePart(currentText)
                      await record("debug", "text.end", {
                        partID: currentText.id,
                        chars: currentText.text.length,
                        text: currentText.text,
                      })
                    }
                    currentText = undefined
                    break

                  case "finish":
                    await record("info", "llm.finish", {
                      finish: input.assistantMessage.finish,
                      cost: input.assistantMessage.cost,
                      tokens: input.assistantMessage.tokens,
                    })
                    break

                  default:
                    log.info("unhandled", {
                      ...value,
                    })
                    continue
                }
                if (needsCompaction) break
              }
            } finally {
              await SessionLog.savePayload({
                id: output,
                sessionID: input.sessionID,
                data: response.full(),
              }).catch((err) => log.warn("response payload log failed", { err, payload: output }))
              stream.release?.()
            }
            if (currentText && !hadTextDelta && !currentText.text && !hasOther) noTextDelta = true
            if (noTextDelta) {
              throw new MessageV2.APIError(
                {
                  message:
                    "The model stream started text output but did not emit any text delta. This usually means a truncated or malformed stream.",
                  isRetryable: true,
                  metadata: {
                    code: "TextStreamNoDelta",
                    reason: "text-start without text-delta",
                  },
                },
                { cause: new Error("text stream missing delta events") },
              )
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              needsCompaction = true
              Bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error,
              })
            } else {
              const retry = SessionRetry.retryable(error)
              if (retry !== undefined) {
                const timed = SessionRetry.timeout(error)
                if (timed && attempt >= SessionRetry.TIMEOUT_MAX_ATTEMPTS) {
                  const reason = "message" in error.data ? error.data.message : error.name
                  const message = `The operation timed out after retrying. ${reason}`
                  input.assistantMessage.error = error
                  await record("error", "llm.timeout", {
                    error: "message" in error.data ? error.data.message : error.name,
                    name: error.name,
                    attempt,
                  })
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.assistantMessage.sessionID,
                    error: input.assistantMessage.error,
                  })
                  SessionStatus.set(input.sessionID, {
                    type: "timeout",
                    message,
                  })
                  failure = e
                  break
                }
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                await record("warn", "llm.retry", {
                  attempt,
                  delay,
                  error: error.name,
                  message: "message" in error.data ? error.data.message : error.name,
                  timeout: timed,
                })
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              input.assistantMessage.error = error
              await record("error", "llm.error", {
                error: "message" in error.data ? error.data.message : error.name,
                name: error.name,
                attempt,
              })
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              SessionStatus.set(input.sessionID, {
                type: "error",
                message: "message" in error.data ? error.data.message : error.name,
              })
              failure = e
            }
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (failure) throw failure
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          if (p.some(action)) return "stop"
          if (!input.assistantMessage.summary) {
            await MemoryStore.capture({ sessionID: input.sessionID }).catch((err) => {
              log.warn("memory capture failed", { err })
            })
          }
          if (input.assistantMessage.finish && !["tool-calls", "unknown"].includes(input.assistantMessage.finish))
            return "stop"
          return "continue"
        }
      },
    }
    return result
  }

  function raw(input: string) {
    const buf = Buffer.from(input)
    const truncated = buf.length > RAW_LIMIT
    return {
      raw: truncated ? buf.subarray(0, RAW_LIMIT).toString("utf8") : input,
      rawBytes: buf.length,
      truncated,
    }
  }

  function action(part: MessageV2.Part) {
    if (part.type !== "tool") return false
    if (part.tool !== LLM.ACTION_RESULT_TOOL) return false
    return part.state.status === "completed"
  }

  function capture() {
    const limit = 128 * 1024
    const item = 16 * 1024
    const events: unknown[] = []
    const full: unknown[] = []
    let bytes = 0
    let chars = 0
    let preview = 0
    let over = false
    let clipped = false
    const data = () => ({
      type: "llm.response",
      events,
      bytes,
      chars,
      previewChars: preview,
      truncated: over || clipped,
    })
    return {
      add(input: unknown) {
        const value = plain(input)
        const source = JSON.stringify(value)
        const total = Buffer.byteLength(source, "utf8")
        full.push(value)
        bytes += total
        chars += source.length
        if (over) return
        const next = pack(value, item)
        const text = JSON.stringify(next)
        const size = Buffer.byteLength(text, "utf8")
        if (source !== text) clipped = true
        if (preview + size > limit) {
          over = true
          const mark = { type: "capture-truncated", reason: "response capture limit reached" }
          const json = JSON.stringify(mark)
          if (preview + json.length <= limit) {
            preview += json.length
            events.push(mark)
          }
          return
        }
        preview += text.length
        events.push(next)
      },
      bytes() {
        return bytes
      },
      chars() {
        return chars
      },
      truncated() {
        return over || clipped
      },
      data() {
        return data()
      },
      full() {
        return {
          type: "llm.response.full",
          events: full,
          bytes,
          chars,
          previewChars: preview,
          truncated: over || clipped,
        }
      },
      text() {
        return JSON.stringify(data(), null, 2)
      },
    }
  }

  function pack(input: unknown, limit: number): unknown {
    const item = plain(input)
    const text = JSON.stringify(item)
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes <= limit) return item
    return mini(item, bytes)
  }

  function mini(input: unknown, bytes: number) {
    const item = obj(input)
    return clean({
      type: typeof item.type === "string" ? item.type : typeof input,
      id: str(item.id),
      toolCallId: str(item.toolCallId),
      toolName: str(item.toolName),
      finishReason: str(item.finishReason),
      input: small(item.input),
      output: small(item.output),
      delta: small(item.delta),
      text: small(item.text),
      error: small(item.error),
      bytes,
      truncated: true,
    })
  }

  function small(input: unknown): unknown {
    if (input === undefined) return undefined
    if (typeof input === "string") return clip(input)
    if (typeof input === "number" || typeof input === "boolean" || input === null) return input
    const text = JSON.stringify(input)
    if (Buffer.byteLength(text, "utf8") <= 4096) return input
    return {
      preview: clip(text),
      truncated: true,
    }
  }

  function clip(input: string) {
    const buf = Buffer.from(input)
    if (buf.length <= 4096) return input
    return buf.subarray(0, 4096).toString("utf8")
  }

  function str(input: unknown) {
    return typeof input === "string" ? input : undefined
  }

  function obj(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function clean(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
  }

  function plain(input: unknown, seen = new WeakSet<object>()): unknown {
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        stack: input.stack,
      }
    }
    if (!input || typeof input !== "object") return input
    if (seen.has(input)) return "[Circular]"
    seen.add(input)
    if (Array.isArray(input)) return input.map((item) => plain(item, seen))
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter((item) => typeof item[1] !== "function")
        .map((item) => [item[0], plain(item[1], seen)]),
    )
  }

  export async function shouldStopCompact(sessionID: SessionID, messageID: MessageID) {
    const logs = (await SessionLog.list({ sessionID, limit: 5000 })).filter(
      (item) => item.type === "llm.preflight_compact" && item.data.user === messageID,
    ).length
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    const empty = msgs.filter(
      (item) =>
        item.info.role === "assistant" &&
        item.info.parentID === messageID &&
        !item.info.finish &&
        !item.info.error &&
        item.parts.length === 0,
    ).length
    return Math.max(logs, empty) >= PREFLIGHT_COMPACT_THRESHOLD
  }
}
