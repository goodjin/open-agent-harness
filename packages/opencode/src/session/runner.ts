import { Log } from "@/util/log"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import { WorkflowExecutor } from "@/workflow/executor"
import type { WorkflowState } from "@/workflow/state"
import { Session } from "."
import { MessageID, PartID, SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { WorkflowParser } from "@/workflow/parser"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import path from "path"
import { AgentProtocolParser } from "@/protocol/parser"
import { AgentProtocolExecutor } from "@/protocol/executor"
import { AgentProtocol } from "@/protocol/schema"
import { SessionLog } from "./log"
import { Agent } from "@/agent/agent"
import { AgentDelegation } from "@/agent/delegation"
import { Identifier } from "@/id/id"
import { RuntimeTools } from "./runtime-tools"
import { PermissionNext } from "@/permission/next"
import { SessionPrompt } from "./prompt"
import { defer } from "@/util/defer"
import { SessionDelegation } from "./delegation"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncation"
import { Question } from "@/question"

export namespace SessionRunner {
  const log = Log.create({ service: "session.runner" })

  export type Kind = "chat" | "workflow" | "protocol"
  export type Info = ReturnType<typeof create>

  export function select(input: { runner?: Kind }): Kind {
    return input.runner ?? "chat"
  }

  export function dispatch<T>(input: { agent: { runner?: Kind } }, run: { chat(): T; workflow(): T; protocol?: () => T }): T {
    if (select(input.agent) === "protocol" && run.protocol) return run.protocol()
    if (select(input.agent) === "workflow") return run.workflow()
    return run.chat()
  }

  export function create(input: Parameters<typeof SessionProcessor.create>[0]) {
    const chat = SessionProcessor.create(input)

    return {
      get message() {
        return chat.message
      },
      partFromToolCall(toolCallID: string) {
        return chat.partFromToolCall(toolCallID)
      },
      async process(stream: LLM.StreamInput) {
        const runner = select(stream.agent)
        const meta = await AgentDelegation.meta(stream.agent.name).catch(() => undefined)
        const msgs = AgentDelegation.messages({ meta, event: "before_model_call" })
        if (msgs.records.length || msgs.diagnostics.length) {
          await SessionLog.emit({
            sessionID: SessionID.make(stream.sessionID),
            messageID: chat.message.id,
            level: msgs.diagnostics.length ? "warn" : "info",
            type: "agent.metadata.messages",
            data: {
              agent: stream.agent.name,
              event: "before_model_call",
              records: msgs.records,
              diagnostics: msgs.diagnostics,
            },
          })
        }
        const next = msgs.records.length
          ? {
              ...stream,
              system: [
                ...msgs.records.filter((item) => item.position === "prefix").map((item) => item.content),
                ...stream.system,
                ...msgs.records.filter((item) => item.position !== "prefix").map((item) => item.content),
              ],
            }
          : stream
        log.info("dispatch", { runner, agent: stream.agent.name })
        return dispatch(next, {
          chat: () => chat.process(next),
          workflow: () => workflow(chat, next),
          protocol: () => protocol(chat, next),
        })
      },
    }
  }

  async function protocol(chat: SessionProcessor.Info, stream: LLM.StreamInput, retry = 0): Promise<SessionProcessor.Result> {
    const result = await chat.process(stream)
    if (chat.message.error) return result
    if (!chat.message.finish || chat.message.finish === "unknown") return result

    const parts = await MessageV2.parts(chat.message.id)
    const text = parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    const native = await nativeOutput(chat.message.id)
    const parsed = native ?? {
      ok: false as const,
      error: { code: "missing_block" as const, message: "No native AgentProtocolOutput tool call found." },
    }
    const invalid = parsed.ok
      ? await invalidOutput(chat.message.id)
      : parsed.error.code === "missing_block"
        ? await invalidOutput(chat.message.id)
        : { error: parsed.error.message, output: "" }
    const partial = chat.message.finish === "length"
    const fixed = undefined
    const valid = parsed.ok && !partial
    const problem = partial
      ? { code: "partial_output", message: "Model output stopped because it reached the output length limit." }
      : invalid
        ? { code: "invalid_tool_call", message: invalid.error }
      : parsed.ok
        ? undefined
        : parsed.error
    const sessionID = SessionID.make(stream.sessionID)
    if (retry > 0 && !invalid && await answer({ sessionID, messageID: chat.message.id, text, problem, finish: chat.message.finish })) {
      await completeAssigned({
        messageID: chat.message.id,
        output: await textOf(chat.message.id),
        sessionID,
        status: chat.message.finish === "error" ? "failed" : "completed",
      })
      return "stop"
    }
    if (!valid && !fixed && retry < 1) {
      await Promise.all(
        parts.flatMap((part) => {
          if (part.type !== "text") return []
          return [
            Session.updatePart({
              ...part,
              ignored: true,
              metadata: {
                ...part.metadata,
                kind: "protocol_malformed",
                recovered: false,
                retry: true,
              },
            }),
          ]
        }),
      )
      await SessionLog.emit({
        sessionID,
        messageID: chat.message.id,
        level: "warn",
        type: "protocol.retry",
        data: {
          reason: invalid ? "invalid_protocol_tool_call" : partial ? "partial_protocol_output" : pseudo(text) ? "non_protocol_tool_call" : "non_protocol_output",
          error: problem,
        },
      })
      const msg = await Session.updateMessage({
        id: MessageID.ascending(),
        parentID: stream.user.id,
        role: "assistant",
        mode: stream.agent.name,
        agent: stream.agent.name,
        variant: stream.user.variant,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: stream.model.id,
        providerID: stream.model.providerID,
        time: {
          created: Date.now(),
        },
        sessionID,
      } as MessageV2.Assistant)
      return protocol(
        SessionProcessor.create({
          assistantMessage: msg as MessageV2.Assistant,
          sessionID,
          model: stream.model,
          abort: stream.abort,
        }),
        {
          ...stream,
          system: [
            ...stream.system,
            [
              "Your previous response violated Agent Protocol DSL v2.",
              invalid
                ? [
                    `Your ${LLM.PROTOCOL_OUTPUT_TOOL} tool call was malformed and could not be parsed as valid JSON.`,
                    "This means the model did not strictly follow the required protocol shape.",
                    invalid.error,
                  ].join("\n")
                : pseudo(text)
                ? "You output a provider-specific textual tool call instead of `agent.protocol.output`."
                : partial
                  ? "Your output was cut off by the model output length limit."
                  : chat.message.finish === "tool-calls"
                    ? `You must call the native ${LLM.PROTOCOL_OUTPUT_TOOL} tool exactly once.`
                  : problem?.code === "multiple_blocks"
                    ? "You output multiple Agent Protocol packages in one response."
                    : "You did not output a valid `agent.protocol.output` package.",
              `Retry now by calling ${LLM.PROTOCOL_OUTPUT_TOOL} exactly once.`,
              "Keep the package small: output only the next necessary item set, preferably no more than 8 items.",
              "If more work is needed after this package executes, wait for the runtime observation and continue in the next turn.",
              "Do not output minimax:tool_call, [TOOL_CALL], XML invoke tags, fake tool results, fenced JSON, or plain Markdown-only answers.",
              "If execution is needed, use `{ version: \"2\", items }` with concrete tool, agent, ask, confirm, or wait items and valid JSON.",
              "If no execution is needed, use an `answer` item and put the Markdown answer in `message`.",
              "Strictly follow the current protocol shape: `{ version: \"2\", items }`.",
            ].join("\n"),
          ],
          toolChoice: { type: "tool", toolName: LLM.PROTOCOL_OUTPUT_TOOL },
        },
        retry + 1,
      )
    }
    if (!valid && !fixed) {
      await malformed(chat.message.id)
      await SessionLog.emit({
        sessionID: SessionID.make(stream.sessionID),
        messageID: chat.message.id,
        level: "warn",
        type: "protocol.malformed",
        data: { recovered: false, error: problem, text },
      })
      return result
    }

    await Promise.all(
      parts.flatMap((part) => {
        if (part.type === "text" && part.text.includes("agent-protocol")) {
          const show = visible(part.text, valid ? parsed.value : undefined)
          if (show.trim().length > 0) {
            return [
              Session.updatePart({
                ...part,
                text: show,
                metadata: {
                  ...part.metadata,
                  kind: "protocol_intro",
                  recovered: !!fixed,
                },
              }),
            ]
          }
          return [
            Session.updatePart({
              ...part,
              ignored: true,
              metadata: {
                ...part.metadata,
                kind: fixed ? "protocol_malformed" : "protocol_dsl",
                recovered: !!fixed,
              },
            }),
          ]
        }
        if (part.type === "text" && fixed) {
          return [
            Session.updatePart({
              ...part,
              ignored: true,
              metadata: {
                ...part.metadata,
                kind: "protocol_malformed",
                recovered: true,
              },
            }),
          ]
        }
        if (part.type === "text" && valid) {
          const message = parsed.value.declaration.message?.trim()
          if (message) {
            return [
              Session.updatePart({
                ...part,
                text: message,
                metadata: {
                  ...part.metadata,
                  kind: "protocol_intro",
                  recovered: false,
                },
              }),
            ]
          }
          return [
            Session.updatePart({
              ...part,
              ignored: true,
              metadata: {
                ...part.metadata,
                kind: "protocol_dsl",
                recovered: false,
              },
            }),
          ]
        }
        if (part.type === "text") {
          return [
            Session.updatePart({
              ...part,
              ignored: true,
              metadata: {
                ...part.metadata,
                kind: "protocol_dsl",
              },
            }),
          ]
        }
        return []
      }),
    )
    await SessionLog.emit({
      sessionID,
      messageID: chat.message.id,
      level: "info",
      type: "protocol.detected",
      data: { agent: stream.agent.name },
    })
    if (fixed) {
      await SessionLog.emit({
        sessionID,
        messageID: chat.message.id,
        level: "warn",
        type: "protocol.malformed",
        data: { recovered: true, error: problem, text },
      })
    }
    const parsedValue = valid ? parsed.value : fixed!
    const msg = native?.ok ? parsedValue.declaration.message?.trim() : ""
    if (msg && parsedValue.declaration.intent === "execute") {
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: chat.message.id,
        sessionID,
        type: "text",
        text: msg,
        metadata: {
          kind: "protocol_intro",
          recovered: /protocol violation recovered/i.test(msg),
        },
        time: { start: Date.now(), end: Date.now() },
      })
    }
    if (parsedValue.declaration.intent !== "execute") {
      await response({
        chat,
        sessionID,
        parsed: parsedValue,
      })
      await completeAssigned({
        messageID: chat.message.id,
        output: await textOf(chat.message.id),
        sessionID,
        status: chat.message.finish === "error" ? "failed" : "completed",
      })
      return "stop"
    }
    const run = await execute({ chat, stream, sessionID, parsed: parsedValue, recovered: !!fixed })
    const raw = await Session.updatePart({
      id: PartID.ascending(),
      messageID: chat.message.id,
      sessionID,
      type: "text",
      text: await transcript(run),
      synthetic: true,
      ignored: true,
      metadata: context(run),
      time: { start: Date.now(), end: Date.now() },
    })
    await project(sessionID, run)
    chat.message.finish = run.status === "failed" ? "error" : "stop"
    chat.message.time.completed = Date.now()
    await Session.updateMessage(chat.message)
    if (run.status !== "blocked") {
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: chat.message.id,
        sessionID,
        type: "text",
        text: await report(run),
        metadata: {
          kind: "protocol_summary",
          action: run.status,
          protocol: {
            runID: run.run_id,
            status: run.status,
            title: run.title,
            metrics: run.metrics,
            resultPartID: raw.id,
          },
        },
        time: { start: Date.now(), end: Date.now() },
      })
      if (!delegated(run)) {
        await final({
          stream,
          run,
        }, 0)
      }
    } else {
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: chat.message.id,
        sessionID,
        type: "text",
        text: summarize(run),
        metadata: {
          kind: "protocol_summary",
          action: run.status,
          protocol: {
            runID: run.run_id,
            status: run.status,
            title: run.title,
            metrics: run.metrics,
            resultPartID: raw.id,
          },
        },
        time: { start: Date.now(), end: Date.now() },
      })
      if (revision(run)) {
        await final({
          stream,
          run,
        }, 0)
      }
    }
    return "stop"
  }

  async function execute(input: {
    chat: SessionProcessor.Info
    stream: LLM.StreamInput
    sessionID: SessionID
    parsed: AgentProtocolParser.Parsed
    recovered: boolean
  }) {
    const runID = Identifier.ascending("log").replace(/^log_/, "apr_")
    const plan = input.parsed.declaration.payload.type === "action_graph" ? input.parsed.declaration.payload.actions : []
    const runtime = input.stream.runtimeTools ?? await RuntimeTools.build({
      agent: input.stream.agent,
      model: input.stream.model,
      session: await Session.get(input.sessionID),
      tools: input.stream.user.tools,
      processor: input.chat,
      bypassAgentCheck: false,
      messages: [],
    })
    await pending(input.sessionID, runID, input.parsed.declaration)
    const agents = AgentDelegation.list(await Agent.list(), input.stream.agent.name)
    const run = await AgentProtocolExecutor.run({
      declaration: input.parsed.declaration,
      sections: input.parsed.sections,
      runID,
      agents: agents.map((item) => ({
        id: item.name,
        entry: item.entry,
        capability: item.capability,
      })),
      execute: (action, prompt) =>
        action.executor.type === "tool"
          ? tool({
              action,
              prompt,
              sessionID: input.sessionID,
              messageID: input.chat.message.id,
              agent: input.stream.agent.name,
              abort: input.stream.abort,
              messages: [],
              model: input.stream.model,
              runtimeTools: runtime,
            })
          : action.executor.type === "agent"
            ? delegate({
                action,
                prompt,
                parentAgent: input.stream.agent.name,
                runID,
                sessionID: input.sessionID,
                messageID: input.chat.message.id,
                abort: input.stream.abort,
                model: input.stream.model,
              })
            : action.executor.type === "human"
                  ? human({
                      action,
                      runID,
                      sessionID: input.sessionID,
                      messageID: input.chat.message.id,
                    })
            : Promise.resolve(undefined),
    })
    await verifierGate({
      actions: plan,
      run,
    })
    await summarizeContinue(run)
    await completeRun({
      agent: input.stream.agent.name,
      messageID: input.chat.message.id,
      run,
      sessionID: input.sessionID,
    })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.chat.message.id,
      level: "info",
      type: "protocol.validated",
      data: { runID: run.run_id, declaration: input.parsed.declaration, recovered: input.recovered },
    })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.chat.message.id,
      level: "info",
      type: "protocol.started",
      data: { runID: run.run_id, title: input.parsed.declaration.title },
    })
    for (const item of run.actions) {
      await SessionLog.emit({
        sessionID: input.sessionID,
        messageID: input.chat.message.id,
        level: item.status === "completed" ? "info" : "warn",
        type: item.status === "completed" ? "protocol.action.completed" : `protocol.action.${item.status}`,
        data: {
          runID: run.run_id,
          actionID: item.id,
          operation: item.operation,
          executor: item.executor,
          status: item.status,
          durationMs: item.duration_ms,
        },
      })
      for (const callID of item.tool_call_ids) {
        await SessionLog.emit({
          sessionID: input.sessionID,
          messageID: input.chat.message.id,
          level: "info",
          type: "protocol.action.tool_call",
          data: {
            runID: run.run_id,
            actionID: item.id,
            callID,
            tool: item.executor.target,
            outputBytes: (item.output ?? item.summary).length,
          },
        })
      }
    }
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.chat.message.id,
      level: run.status === "completed" ? "info" : "warn",
      type: run.status === "completed" ? "protocol.completed" : "protocol.failed",
      data: {
        runID: run.run_id,
        result: run,
        metrics: {
          modelVisibleBytes: run.metrics.model_visible_bytes,
          durationMs: run.metrics.duration_ms,
        },
      },
    })
    return run
  }

  async function verifierGate(input: {
    actions: AgentProtocol.Action[]
    run: AgentProtocol.Result
  }) {
    if (input.actions.length === 0) return
    const depsByID = new Map<string, readonly string[]>()
    const kindByAction = new Map<string, string | undefined>()
    const kindByAgent = new Map<string, string | undefined>()
    for (const action of input.actions) {
      if (action.executor.type === "agent") {
        depsByID.set(action.id, action.depends_on)
        const current = kindByAgent.get(action.executor.target)
        const kind = current ?? (kindByAgent.set(action.executor.target, (await Agent.get(action.executor.target))?.kind).get(action.executor.target))
        kindByAction.set(action.id, kind)
      }
    }
    if (kindByAction.size === 0) return

    const resultByID = new Map(input.run.actions.map((item) => [item.id, item] as const))

    for (const [id, action] of resultByID) {
      if (action.executor.type !== "agent") continue
      if (kindByAction.get(id) !== "verifier") continue
      if (action.status !== "failed" && action.status !== "blocked") continue
      const deps = depsByID.get(id) ?? []
      const workerID = deps.find((item) => kindByAction.get(item) === "worker")
      const target = workerID ?? deps.find((item) => {
        const result = resultByID.get(item)
        return result?.executor.type === "agent" && typeof result.sessionID === "string"
      })
      if (!target) continue
      const worker = resultByID.get(target)
      if (!worker?.sessionID || !action.sessionID) continue

      const handoff = await verifyLoop({
        action,
        verifierID: id,
        verifierSession: SessionID.make(action.sessionID),
        workerSession: SessionID.make(worker.sessionID),
        report: action.output ?? action.summary,
      })
      if (!handoff) continue
      action.status = handoff.status
      action.summary = handoff.summary
      if (handoff.output) action.output = handoff.output
      if (handoff.error) action.error = handoff.error
    }

    input.run.status =
      input.run.actions.some((item) => item.status === "failed")
        ? "failed"
        : input.run.actions.some((item) => item.status === "blocked")
          ? "blocked"
          : "completed"
    input.run.summary = input.run.actions.map((item) => `${item.title}: ${item.status}`).join("\n")
  }

  async function verifyLoop(input: {
    action: AgentProtocol.ResultAction
    verifierID: string
    verifierSession: SessionID
    workerSession: SessionID
    report: string
  }) {
    let output = input.report ?? ""
    let status = input.action.status
    let error: string | undefined

    for (let i = 0; i < 2 && (status === "failed" || status === "blocked"); i++) {
      try {
        await continueSession(input.workerSession, [
          `Verifier ${input.verifierID} found issues:`,
          output,
          "",
          "Please continue from the current state, apply fixes, and report results for re-verification.",
        ].join("\n"))

        const retry = await continueSession(input.verifierSession, [
          `Please re-verify the worker task for action ${input.verifierID} after the worker's fix.`,
          "Return a clear PASS when done, otherwise include concrete unresolved issues.",
          "",
          `Previous report:\n${output}`,
        ].join("\n"))

        output = await assistantText(input.verifierSession, retry.info.id)
      } catch (err) {
        status = "blocked"
        error = err instanceof Error ? err.message : "Failed to complete verifier handoff."
        break
      }

      if (!output) {
        status = "blocked"
        error = "Unable to get verifier retry output."
        break
      }
      status = verifyPass(output) ? "completed" : "blocked"
      if (status === "completed") {
        error = undefined
      }
    }

    if (status === "blocked" && !error) {
      error = `Verifier ${input.verifierID} still reports unresolved issues.`
    }

    return {
      status,
      summary: status === "completed"
        ? `Verifier ${input.verifierID} passed after runtime handoff.`
        : `Verifier ${input.verifierID} did not pass after runtime handoff.`,
      output,
      error,
    }
  }

  async function continueSession(sessionID: SessionID, prompt: string) {
    const delegated = await delegatedAgent(sessionID)
    return SessionPrompt.prompt({
      sessionID,
      agent: delegated,
      parts: [
        {
          type: "text",
          text: prompt,
        },
      ],
    })
  }

  function verifyPass(input: string) {
    const text = input.toLowerCase()
    if (/(fail|failed|失败|不通过|未通过|fix|need|问题|缺陷|错误|blocked|abort)/.test(text)) return false
    return /\b(pass|passed|approve|approved|通过|ok|good|accept|passed|通过验证|无问题|all good)\b/.test(text)
  }

  function summarizeContinue(run: AgentProtocol.Result) {
    const rows = run.actions
      .filter((item) => item.executor.type === "tool" && item.executor.target === "session_continue")
      .map((item) => {
        const parsed = parseContinue(item.output)
        const status = parsed?.status
          ? typeof statusValue(parsed.status) === "string"
            ? statusValue(parsed.status)
            : "unknown"
          : item.status
        return {
          id: item.id,
          child: parsed?.child_session_id,
          status,
          finish: parsed?.finish,
          text: parsed?.reply,
        }
      })
      .filter((item) => item.child || item.text)
    if (rows.length === 0) return
    run.summary = [
      run.summary,
      "",
      "Session continue replies:",
      ...rows.map((item) => {
        const status = typeof item.status === "string" ? item.status : "unknown"
        const done = item.text ? item.text.replace(/\n+/g, " ").slice(0, 220) : "(no textual reply)"
        return `- ${item.id} (${item.child ?? "child"}): ${status}${item.finish ? `, ${item.finish}` : ""} - ${done}`
      }),
    ].join("\n")
  }

  function statusValue(input: unknown) {
    if (typeof input === "string") return input
    if (input && typeof input === "object" && !Array.isArray(input) && "type" in input && typeof input.type === "string") return input.type
    return
  }

  function parseContinue(input?: string) {
    if (typeof input !== "string") return
    try {
      const data = JSON.parse(input) as {
        kind?: string
        child_session_id?: string
        status?: unknown
        finish?: string
        reply?: string
      }
      if (data.kind !== "session_continue_result") return
      return data
    } catch {
      return
    }
  }

  async function assistantText(sessionID: SessionID, messageID: MessageID) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    const msg = msgs.find((item) => item.info.id === messageID) ?? msgs.findLast((item) => item.info.role === "assistant")
    return msg?.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
      || ""
  }

  async function delegatedAgent(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    const delegated = object(object(session.dsl_context).protocol).delegation
    if (!delegated || typeof delegated !== "object" || Array.isArray(delegated)) return "default"
    const item = object(delegated)
    return text(item.agent) || "default"
  }

  async function completeRun(input: {
    agent: string
    messageID: MessageID
    run: AgentProtocol.Result
    sessionID: SessionID
  }) {
    const meta = await AgentDelegation.meta(input.agent).catch(() => undefined)
    const done = AgentDelegation.complete({
      agent: input.agent,
      meta,
      results: [
        await proof(input.run),
        ...input.run.actions.flatMap((item) =>
          item.output
            ? [
                {
                  content: item.output,
                  source: item.executor.target,
                },
              ]
            : []),
      ],
      status: input.run.status === "failed" ? "failed" : "completed",
    })
    await completionLog({
      agent: input.agent,
      complete: done,
      messageID: input.messageID,
      sessionID: input.sessionID,
    })
    await followup({
      agent: input.agent,
      complete: done,
      messageID: input.messageID,
      sessionID: input.sessionID,
    })
    if (input.run.status !== "completed") return
    if (done.status === "completed") return
    input.run.status = "blocked"
    input.run.summary = [
      input.run.summary,
      "",
      "Metadata completion gate rejected completed status.",
      `next: ${done.completion.next}`,
      done.completion.missing_artifacts.length ? `missing_artifacts: ${done.completion.missing_artifacts.join(", ")}` : "",
      done.completion.missing_evidence.length ? `missing_evidence: ${done.completion.missing_evidence.join(", ")}` : "",
    ].filter((item) => item.length > 0).join("\n")
  }

  async function answer(input: {
    sessionID: SessionID
    messageID: MessageID
    text: string
    problem: { code: string } | undefined
    finish: MessageV2.Assistant["finish"]
  }) {
    const text = input.text.trim()
    if (!text) return false
    if (input.finish !== "stop") return false
    if (input.problem?.code !== "missing_block") return false
    if (pseudo(text)) return false
    if (!(await previous(input.sessionID))) return false
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.messageID,
      level: "info",
      type: "protocol.final.plain",
      data: { textBytes: text.length, source: "followup" },
    })
    return true
  }

  async function previous(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    const ctx = session.dsl_context && typeof session.dsl_context === "object" && !Array.isArray(session.dsl_context) ? session.dsl_context : {}
    const protocol = ctx.protocol && typeof ctx.protocol === "object" && !Array.isArray(ctx.protocol) ? ctx.protocol as Record<string, unknown> : undefined
    if (!protocol) return false
    if (Array.isArray(protocol.runs) && protocol.runs.length > 0) return true
    if (Array.isArray(protocol.completed_delegations) && protocol.completed_delegations.length > 0) return true
    if (protocol.delegation && typeof protocol.delegation === "object") return true
    return false
  }

  async function final(input: {
    stream: LLM.StreamInput
    run: AgentProtocol.Result
  }, retry: number, missing = 0) {
    const msg = (await Session.updateMessage({
      id: MessageID.ascending(),
      parentID: input.stream.user.id,
      role: "assistant",
      mode: input.stream.agent.name,
      agent: input.stream.agent.name,
      variant: input.stream.user.variant,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: input.stream.model.id,
      providerID: input.stream.model.providerID,
      time: {
        created: Date.now(),
      },
      sessionID: SessionID.make(input.stream.sessionID),
    } as MessageV2.Assistant)) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg as MessageV2.Assistant,
      sessionID: SessionID.make(input.stream.sessionID),
      model: input.stream.model,
      abort: input.stream.abort,
    })
    const prompt = [
      "You are writing the final user-facing answer after an Agent Protocol DSL run.",
      "This is not an execution turn. The runtime has already executed every available call.",
      `Use only the conversation turns below, then decide the final protocol response.`,
      `You must call ${LLM.PROTOCOL_OUTPUT_TOOL} exactly once.`,
      'Use an `answer` item when there is user-visible final content, and put the final Markdown answer in `message`.',
      'Use a `done` item when there is nothing else useful to add.',
      "Do not output ordinary Markdown directly unless the runtime explicitly falls back after a failed retry.",
      "Only use tool, agent, ask, confirm, or wait items if another runtime call is truly required.",
      "Never write, request, or simulate business tool calls. Never output provider-specific textual tool calls.",
      "The full conversation history is preserved. Resolve references like \"these errors\", \"continue\", or \"fix them\" from the earlier turns.",
      "Strictly follow the current protocol shape: `{ version: \"2\", items }`.",
      missing > 0
        ? [
            "",
            "Protocol retry warning:",
            `Your previous final response did not call the native ${LLM.PROTOCOL_OUTPUT_TOOL} tool.`,
            `Retry now by calling ${LLM.PROTOCOL_OUTPUT_TOOL} exactly once with an \`answer\` item, a \`done\` item, or strictly necessary runtime items.`,
          ].join("\n")
        : "",
      retry > 0
        ? [
            "",
            "Loop warning:",
            "You already requested additional runtime calls after a completed protocol run.",
            "Read the full prior runtime observations before asking for more calls.",
            "Do not repeat the same read/search/build/check calls. If enough information is available, answer or edit instead of looping.",
            retry >= 6
              ? [
                  "",
                  "Soft runtime limit reached:",
                  "Do not request more runtime calls unless this turn will make a concrete change or verification that is impossible from current observations.",
                  "If you are still diagnosing, answer with a concise diagnosis, the specific missing fact, and the next recommended action instead of calling runtime again.",
                ].join("\n")
              : "",
          ].join("\n")
        : "",
    ].join("\n")
    await SessionLog.emit({
      sessionID: SessionID.make(input.stream.sessionID),
      messageID: msg.id,
      level: "info",
      type: "protocol.final.started",
      data: { runID: input.run.run_id, sourceMessageID: input.stream.user.id },
    })
    await processor.process({
      ...input.stream,
      agent: {
        ...input.stream.agent,
        runner: "protocol",
      },
      system: [prompt],
      tools: {},
      messages: await history(input.stream, SessionID.make(input.stream.sessionID)),
    })
    const parsed = await protocolOutput(msg.id)
    if (parsed?.ok) {
      const sessionID = SessionID.make(input.stream.sessionID)
      if (parsed.value.declaration.intent === "execute") {
        await intro({
          messageID: msg.id,
          sessionID,
          parsed: parsed.value,
          recovered: false,
        })
        const reason = cycle(input.run, parsed.value.declaration, retry)
        if (reason) {
          await loop({
            message: msg,
            sessionID,
            runID: input.run.run_id,
            reason,
          })
          return
        }
        const run = await execute({ chat: processor, stream: input.stream, sessionID, parsed: parsed.value, recovered: false })
        const raw = await Session.updatePart({
          id: PartID.ascending(),
          messageID: processor.message.id,
          sessionID,
          type: "text",
          text: await transcript(run),
          synthetic: true,
          ignored: true,
          metadata: context(run),
          time: { start: Date.now(), end: Date.now() },
        })
        await project(sessionID, run)
        if (run.status !== "blocked") {
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: processor.message.id,
            sessionID,
            type: "text",
            text: await report(run),
            metadata: {
              kind: "protocol_summary",
              action: run.status,
              protocol: {
                runID: run.run_id,
                status: run.status,
                title: run.title,
                metrics: run.metrics,
                resultPartID: raw.id,
              },
            },
            time: { start: Date.now(), end: Date.now() },
          })
          if (!delegated(run)) {
            await final({
              stream: input.stream,
              run,
            }, retry + 1)
          }
          return
        } else {
          processor.message.finish = "stop"
          processor.message.time.completed = Date.now()
          await Session.updateMessage(processor.message)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: processor.message.id,
            sessionID,
            type: "text",
            text: summarize(run),
            metadata: {
              kind: "protocol_summary",
              action: run.status,
              protocol: {
                runID: run.run_id,
                status: run.status,
                title: run.title,
                metrics: run.metrics,
                resultPartID: raw.id,
              },
            },
            time: { start: Date.now(), end: Date.now() },
          })
          if (revision(run)) {
            await final({
              stream: input.stream,
              run,
            }, retry + 1)
          }
        }
      } else {
        await response({
          chat: processor,
          sessionID,
          parsed: parsed.value,
        })
      }
    } else {
      const text = await textOf(msg.id)
      if (parsed && missing < 1) {
        await SessionLog.emit({
          sessionID: SessionID.make(input.stream.sessionID),
          messageID: msg.id,
          level: "warn",
          type: "protocol.final.retry",
          data: { runID: input.run.run_id, reason: "invalid_protocol_tool_call", error: parsed.error },
        })
        msg.finish = "stop"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)
        await final(input, retry, missing + 1)
        return
      }
      if (text.trim().length > 0 && missing < 1) {
        const parts = await MessageV2.parts(msg.id)
        await Promise.all(
          parts.flatMap((part) => {
            if (part.type !== "text") return []
            return [
              Session.updatePart({
                ...part,
                ignored: true,
                metadata: {
                  ...part.metadata,
                  kind: "protocol_final_missing_tool",
                  retry: true,
                },
              }),
            ]
          }),
        )
        await SessionLog.emit({
          sessionID: SessionID.make(input.stream.sessionID),
          messageID: msg.id,
          level: "warn",
          type: "protocol.final.retry",
          data: { runID: input.run.run_id, reason: "missing_tool_call", textBytes: text.length },
        })
        msg.finish = "stop"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)
        await final(input, retry, missing + 1)
        return
      }
      if (text.trim().length === 0) {
        if (missing < 1) {
          await SessionLog.emit({
            sessionID: SessionID.make(input.stream.sessionID),
            messageID: msg.id,
            level: "warn",
            type: "protocol.final.retry",
            data: { runID: input.run.run_id, reason: "empty_final_output" },
          })
          msg.finish = "stop"
          msg.time.completed = Date.now()
          await Session.updateMessage(msg)
          await final(input, retry, missing + 1)
          return
        }
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: SessionID.make(input.stream.sessionID),
          type: "text",
          text: "Protocol final response was empty or malformed.",
          metadata: {
            kind: "protocol_malformed",
            action: "failed",
            protocol: {
              runID: input.run.run_id,
            },
          },
          time: { start: Date.now(), end: Date.now() },
        })
        await SessionLog.emit({
          sessionID: SessionID.make(input.stream.sessionID),
          messageID: msg.id,
          level: "warn",
          type: "protocol.final.malformed",
          data: { runID: input.run.run_id, reason: "empty_final_output" },
        })
        msg.finish = "error"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)
        return
      }
      await SessionLog.emit({
        sessionID: SessionID.make(input.stream.sessionID),
        messageID: msg.id,
        level: pseudo(text) ? "warn" : "info",
        type: pseudo(text) ? "protocol.final.plain_tool_syntax" : "protocol.final.plain",
        data: { runID: input.run.run_id, textBytes: text.length, fallback: missing > 0 },
      })
    }
    await SessionLog.emit({
      sessionID: SessionID.make(input.stream.sessionID),
      messageID: msg.id,
      level: "info",
      type: "protocol.final.completed",
      data: { runID: input.run.run_id },
    })
    await completeAssigned({
      messageID: msg.id,
      output: await textOf(msg.id),
      sessionID: SessionID.make(input.stream.sessionID),
      status: msg.finish === "error" ? "failed" : "completed",
    })
  }

  async function history(stream: LLM.StreamInput, sessionID: SessionID) {
    const messages = MessageV2.toModelMessages(await MessageV2.filterCompacted(MessageV2.stream(sessionID)), stream.model)
    if (messages.length >= stream.messages.length) return messages
    return [...stream.messages, ...messages]
  }

  async function loop(input: {
    message: MessageV2.Assistant
    sessionID: SessionID
    runID: string
    reason: string
  }) {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: input.message.id,
      sessionID: input.sessionID,
      type: "text",
      text: [
        "Protocol loop guard triggered.",
        "",
        input.reason,
        "",
        "The request was stopped to avoid an infinite loop.",
        "",
        "Review the protocol log and continue with a more specific instruction if more work is needed.",
      ].join("\n"),
      metadata: {
        kind: "protocol_loop_guard",
        action: "stopped",
        protocol: {
          runID: input.runID,
        },
      },
      time: { start: Date.now(), end: Date.now() },
    })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.message.id,
      level: "warn",
      type: "protocol.loop_guard.triggered",
      data: { runID: input.runID, reason: input.reason },
    })
    input.message.finish = "stop"
    input.message.time.completed = Date.now()
    await Session.updateMessage(input.message)
  }

  function cycle(run: AgentProtocol.Result, declaration: AgentProtocol.Declaration, retry: number) {
    if (retry === 0) return
    if (repeat(run, declaration)) return "The model repeated the same runtime calls after it had already been warned to avoid repeated protocol execution."
    if (retry >= 12) return "The model kept requesting runtime execution after the soft runtime limit instead of providing a diagnosis and next step."
  }

  function repeat(run: AgentProtocol.Result, declaration: AgentProtocol.Declaration) {
    if (declaration.payload.type !== "action_graph") return false
    const before = run.actions.map((item) => sig(item)).sort()
    const after = declaration.payload.actions.map((item) => sig(item)).sort()
    return before.length > 0 && before.length === after.length && before.every((item, index) => item === after[index])
  }

  function sig(action: AgentProtocol.Action | AgentProtocol.ResultAction) {
    return stable({
      operation: action.operation,
      executor: action.executor,
      input: action.input ?? {},
    })
  }

  function stable(input: unknown): string {
    if (input === undefined) return ""
    if (input === null || typeof input !== "object") return JSON.stringify(input)
    if (Array.isArray(input)) return `[${input.map((item) => stable(item)).join(",")}]`
    const value = input as globalThis.Record<string, unknown>
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`
  }

  async function textOf(messageID: MessageID) {
    return (await MessageV2.parts(messageID))
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
  }

  async function malformed(messageID: MessageID) {
    const parts = await MessageV2.parts(messageID)
    await Promise.all(
      parts.flatMap((part) => {
        if (part.type !== "text") return []
        return [
          Session.updatePart({
            ...part,
            ignored: true,
            metadata: {
              ...part.metadata,
              kind: "protocol_malformed",
              recovered: false,
              retry: true,
            },
          }),
        ]
      }),
    )
  }

  async function response(input: {
    chat: SessionProcessor.Info
    sessionID: SessionID
    parsed: AgentProtocolParser.Parsed
  }) {
    const ref = input.parsed.declaration.response_ref
    const text = ref?.startsWith("md:") ? input.parsed.sections[ref.slice(3)] : input.parsed.declaration.message
    if (text) {
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: input.chat.message.id,
        sessionID: input.sessionID,
        type: "text",
        text,
        metadata: {
          kind: "protocol_response",
          action: input.parsed.declaration.intent,
          protocol: {
            title: input.parsed.declaration.title,
            responseRef: ref,
          },
        },
        time: { start: Date.now(), end: Date.now() },
      })
    }
    input.chat.message.finish = "stop"
    input.chat.message.time.completed = Date.now()
    await Session.updateMessage(input.chat.message)
  }

  async function intro(input: {
    messageID: MessageID
    sessionID: SessionID
    parsed: AgentProtocolParser.Parsed
    recovered: boolean
  }) {
    const msg = input.parsed.declaration.message?.trim()
    if (!msg) return
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      text: msg,
      metadata: {
        kind: "protocol_intro",
        recovered: input.recovered,
      },
      time: { start: Date.now(), end: Date.now() },
    })
  }

  async function protocolOutput(messageID: MessageID) {
    return nativeOutput(messageID)
  }

  async function nativeOutput(messageID: MessageID): Promise<AgentProtocolParser.Result | undefined> {
    const parts = await MessageV2.parts(messageID)
    const part = parts.find(
      (item): item is MessageV2.ToolPart =>
        item.type === "tool" &&
        item.tool === LLM.PROTOCOL_OUTPUT_TOOL &&
        (item.state.status === "running" || item.state.status === "completed"),
    )
    const input = part?.state.input
    if (!input) return
    try {
      return {
        ok: true,
        value: {
          declaration: AgentProtocol.parse(input),
          sections: {},
          raw: JSON.stringify(input),
        },
      }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "invalid_schema",
          message: err instanceof globalThis.Error ? err.message : "Agent protocol tool input schema validation failed.",
        },
      }
    }
  }

  async function invalidOutput(messageID: MessageID) {
    const parts = await MessageV2.parts(messageID)
    const part = parts.find(
      (item): item is MessageV2.ToolPart =>
        item.type === "tool" &&
        item.tool === "invalid" &&
        item.state.status === "completed" &&
        item.state.metadata?.protocol === true &&
        item.state.metadata.violation === "direct_tool_call" &&
        item.state.input.tool === LLM.PROTOCOL_OUTPUT_TOOL,
    )
    if (!part || part.state.status !== "completed") return
    return {
      error: part.state.input.error?.toString() || part.state.output,
      output: part.state.output,
    }
  }

  async function transcript(run: AgentProtocol.Result) {
    const calls = await Promise.all(run.actions.map((item) => call(item)))
    return [
      "## Assistant protocol request and runtime results",
      "",
      `run_id: \`${run.run_id}\``,
      run.title ? `Purpose: ${run.title}` : "",
      `Status: ${run.status}`,
      "",
      ...calls.flat(),
    ]
      .filter((line) => line.length > 0)
      .join("\n")
  }

  async function call(item: AgentProtocol.ResultAction) {
    const args = JSON.stringify(item.input ?? {}, null, 2)
    const result = item.error ?? item.output ?? item.summary
    return [
      `### Call ${item.id}`,
      "",
      `Tool: \`${item.executor.target}\``,
      "",
      "```shell",
      `tool ${item.executor.target} <<'JSON'`,
      args,
      "JSON",
      "```",
      "",
      `### Result for ${item.id}`,
      "",
      `Status: ${item.status}`,
      item.tool_call_ids.length ? `Artifacts: ${item.tool_call_ids.map((id) => `artifact://${id}`).join(", ")}` : "",
      "",
      "```md",
      await clip(result),
      "```",
      "",
    ].filter((line) => line.length > 0)
  }

  function context(run: AgentProtocol.Result) {
    return {
      kind: "protocol_context",
      action: run.status,
      protocol: {
        type: run.type,
        version: run.version,
        run_id: run.run_id,
        status: run.status,
        title: run.title,
        metrics: run.metrics,
        actions: run.actions.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          executor: item.executor,
          output_bytes: (item.output ?? item.error ?? item.summary).length,
          tool_call_ids: item.tool_call_ids,
        })),
      },
    }
  }

  function visible(text: string, parsed: AgentProtocolParser.Parsed | undefined) {
    const clean = text
      .replace(/```json\s+agent-protocol[\s\S]*?```/g, "")
      .replace(/```\s*agent-protocol[\s\S]*?```/g, "")
      .trim()
    if (clean) return clean
    const msg = parsed?.declaration.message?.trim()
    if (msg) return msg
    return ""
  }

  function summarize(run: AgentProtocol.Result) {
    const title = run.title ?? "Protocol run"
    const head =
      run.status === "completed"
        ? `Protocol completed: ${title}`
        : run.status === "blocked"
          ? `Protocol blocked: ${title}`
          : `Protocol failed: ${title}`
    const actions = run.actions
      .map((item) => {
        const bytes = (item.output ?? item.error ?? item.summary).length
        const calls = item.tool_call_ids.length
        return `- ${item.title}: ${item.status}${calls ? `, ${calls} internal tool call${calls === 1 ? "" : "s"}` : ""}, ${bytes} output bytes`
      })
      .join("\n")
    return [
      head,
      actions,
      "",
      `Run ID: ${run.run_id}`,
      `Direct model tool calls: ${run.metrics.direct_model_tool_calls}`,
      `Internal protocol tool calls: ${run.metrics.internal_tool_calls}`,
    ]
      .filter((item) => item.length > 0)
      .join("\n")
  }

  async function report(run: AgentProtocol.Result) {
    const actions = await Promise.all(
      run.actions.map(async (item) => {
        const out = item.error ?? item.output ?? item.summary
        return [
          `### ${item.title}`,
          `Agent: \`${item.executor.target}\``,
          `Status: ${item.status}`,
          "",
          await clip(out),
          "",
        ]
      }),
    )
    return [
      `Protocol results: ${run.title ?? run.run_id}`,
      `Status: ${run.status}`,
      "",
      ...actions.flat(),
      `Run ID: ${run.run_id}`,
    ]
      .filter((item) => item.length > 0)
      .join("\n")
  }

  export async function proof(run: AgentProtocol.Result) {
    return {
      content: await report(run),
      source: "protocol",
      metadata: {
        evidence: [
          {
            kind: "protocol_run_state_or_direct_answer",
            id: run.run_id,
            title: "protocol_run_state_or_direct_answer",
            status: run.status,
          },
        ],
        artifact: {
          name: "agent_protocol_plan",
          type: "protocol",
          content_type: "application/vnd.agent-protocol+json",
          content: context(run).protocol,
          source: "protocol",
        },
      },
    }
  }

  async function clip(input: string) {
    return (await Truncate.output(input)).content
  }

  function delegated(run: AgentProtocol.Result) {
    return run.actions.some((item) =>
      (item.output ?? item.summary).includes("The parent session will resume automatically when the child result is available.")
    )
  }

  function revision(run: AgentProtocol.Result) {
    return run.status === "blocked" && run.actions.some((item) => item.operation === "confirm" && item.status === "blocked")
  }

  function pseudo(text: string) {
    return /\bminimax:tool_call\b|<minimax:tool_call>|<invoke\s+name=|\[TOOL_CALL\]|\btool[_-]call\b|"type"\s*:\s*"tool-call"|"(?:toolName|name)"\s*:\s*"AgentProtocolOutput"|\btool\s*=>/i.test(text)
  }

  async function human(input: {
    action: AgentProtocol.Action
    runID: string
    sessionID: SessionID
    messageID: MessageID
  }): Promise<AgentProtocolExecutor.ToolResult> {
    if (input.action.operation === "confirm") return confirm(input)
    return inquire(input)
  }

  async function inquire(input: {
    action: AgentProtocol.Action
    runID: string
    sessionID: SessionID
    messageID: MessageID
  }): Promise<AgentProtocolExecutor.ToolResult> {
    const data = object(input.action.input)
    const options = Array.isArray(data.options)
      ? data.options.flatMap((item) => {
          const opt = object(item)
          const label = typeof opt.label === "string" ? opt.label.trim() : ""
          if (!label) return []
          return [{
            label,
            description: typeof opt.description === "string" ? opt.description : label,
          }]
        })
      : []
    const answers = await Question.ask({
      sessionID: input.sessionID,
      questions: [{
        question: typeof data.prompt === "string" ? data.prompt : input.action.title,
        header: input.action.title.slice(0, 30),
        options,
        multiple: data.mode === "multi",
        custom: data.allow_custom !== false,
      }],
      tool: { messageID: input.messageID, callID: `call_${input.action.id}` },
    })
    return {
      title: input.action.title,
      output: `User answered: ${(answers[0] ?? []).join(", ") || "Unanswered"}`,
      metadata: { answers },
    }
  }

  async function confirm(input: {
    action: AgentProtocol.Action
    runID: string
    sessionID: SessionID
    messageID: MessageID
  }): Promise<AgentProtocolExecutor.ToolResult> {
    const data = object(input.action.input)
    const plan = typeof data.plan === "string" ? data.plan : ""
    const prompt = typeof data.prompt === "string" ? data.prompt : "Please confirm this plan before execution."
    await storeConfirm({
      action: input.action,
      messageID: input.messageID,
      plan,
      runID: input.runID,
      sessionID: input.sessionID,
      status: "pending",
    })
    const answers = await Question.ask({
      sessionID: input.sessionID,
      questions: [{
        question: [prompt, "", plan].filter((item) => item.trim().length > 0).join("\n"),
        header: "Confirm plan",
        options: [
          { label: "Confirm", description: "Approve this plan and continue execution." },
          { label: "Continue editing", description: "Send feedback so the planner can revise the plan." },
        ],
        multiple: false,
        custom: false,
      }],
      tool: { messageID: input.messageID, callID: `call_${input.action.id}` },
    })
    const answer = answers[0]?.[0] ?? ""
    const ok = /^confirm\b/i.test(answer)
    const note = answer.includes(":") ? answer.slice(answer.indexOf(":") + 1).trim() : ""
    await storeConfirm({
      action: input.action,
      messageID: input.messageID,
      note,
      plan,
      runID: input.runID,
      sessionID: input.sessionID,
      status: ok ? "confirmed" : "revision_requested",
    })
    if (ok) {
      return {
        title: input.action.title,
        output: ["Plan confirmed by user.", note ? `User note: ${note}` : ""].filter((item) => item.length > 0).join("\n"),
        metadata: { confirmed: true, note },
      }
    }
    return {
      title: input.action.title,
      output: [
        "User requested changes to the plan.",
        note ? `Requested changes: ${note}` : "",
        "Revise the plan and ask for confirmation again before executing downstream work.",
      ].filter((item) => item.length > 0).join("\n"),
      metadata: { blocked: true, confirmed: false, note, revision: true },
    }
  }

  async function storeConfirm(input: {
    action: AgentProtocol.Action
    messageID: MessageID
    note?: string
    plan: string
    runID: string
    sessionID: SessionID
    status: "pending" | "confirmed" | "revision_requested"
  }) {
    const item = {
      type: "agent.protocol.confirmation",
      version: "1",
      run_id: input.runID,
      action_id: input.action.id,
      action_title: input.action.title,
      message_id: input.messageID,
      plan: input.plan,
      note: input.note,
      status: input.status,
      updated_at: Date.now(),
    }
    await Storage.write(["session_protocol_confirmation", input.sessionID, input.runID, input.action.id], item)
    const session = await Session.get(input.sessionID)
    const ctx = object(session.dsl_context)
    const prev = object(ctx.protocol)
    const vals = Array.isArray(prev.confirmations) ? prev.confirmations : []
    await Session.setDslContext({
      sessionID: input.sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          confirmations: [
            ...vals.filter((val) => {
              const rec = object(val)
              return rec.run_id !== input.runID || rec.action_id !== input.action.id
            }),
            {
              ...item,
              plan_ref: ["session_protocol_confirmation", input.sessionID, input.runID, input.action.id].join("/"),
            },
          ],
        },
      },
    })
  }

  async function delegate(input: {
    action: AgentProtocol.Action
    prompt: string | undefined
    parentAgent: string
    runID: string
    sessionID: SessionID
    messageID: MessageID
    abort: AbortSignal
    model: LLM.StreamInput["model"]
  }): Promise<AgentProtocolExecutor.ToolResult> {
    const selected = await fallback(input.action, input.parentAgent, "target_unavailable")
    if (!selected.ok) {
      return {
        title: input.action.title,
        output: selected.error,
        metadata: { blocked: true },
      }
    }
    const meta = await AgentDelegation.meta(selected.agent.name).catch(() => undefined)
    const gate = AgentDelegation.runtime({
      agent: selected.agent.name,
      meta,
      action: input.action,
    })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.messageID,
      level: gate.status === "ready" ? "info" : "warn",
      type: "agent.metadata.assignment",
      data: {
        actionID: input.action.id,
        agent: selected.agent.name,
        status: gate.status,
        input: gate.input,
        collaboration: gate.collaboration,
        boundary: gate.boundary,
        snapshot: gate.snapshot,
        observability: gate.observability,
      },
    })
    if (gate.status !== "ready") {
      const next = await fallback(input.action, input.parentAgent, "metadata_blocked", gate)
      if (next.ok && next.agent.name !== selected.agent.name) {
        return delegate({
          ...input,
          action: {
            ...input.action,
            executor: {
              ...input.action.executor,
              target: next.agent.name,
            },
          },
        })
      }
      return {
        title: input.action.title,
        output: [
          `Protocol agent blocked by metadata control-plane: ${selected.agent.name}`,
          `status: ${gate.status}`,
          gate.input.missing_inputs.length ? `missing_inputs: ${gate.input.missing_inputs.join(", ")}` : "",
          gate.collaboration.items.length ? `collaboration_plan: ${gate.collaboration.items.map((item) => `${item.edge_kind}:${item.target}`).join(", ")}` : "",
          gate.boundary.candidates.length ? `boundary: ${gate.boundary.candidates.map((item) => `${item.resource}.${item.action}:${item.status}`).join(", ")}` : "",
        ].filter((item) => item.length > 0).join("\n"),
        metadata: { blocked: true, agentID: selected.agent.name, metadata: gate },
      }
    }
    const parent = await Session.get(input.sessionID)
    const source = await Agent.get(input.parentAgent)
    const rule = PermissionNext.evaluate("task", selected.agent.name, source ? Agent.permissions(source, parent.permission) : parent.permission ?? [])
    if (rule.action === "deny") {
      const next = await fallback(input.action, input.parentAgent, "target_denied", gate)
      if (next.ok && next.agent.name !== selected.agent.name) {
        return delegate({
          ...input,
          action: {
            ...input.action,
            executor: {
              ...input.action.executor,
              target: next.agent.name,
            },
          },
        })
      }
      return {
        title: input.action.title,
        output: `Protocol agent denied: ${selected.agent.name}`,
        metadata: { blocked: true, agentID: selected.agent.name, metadata: gate },
      }
    }
    const title = input.action.title.trim()
    const child = await Session.create({
      parentID: parent.id,
      title: `Protocol: ${title} (@${selected.agent.name})`,
      permission: [
        ...Agent.permissions(selected.agent, parent.permission),
        { permission: "workflow_create", pattern: "*", action: "deny" },
        { permission: "workflow_start", pattern: "*", action: "deny" },
      ],
    })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.messageID,
      level: "info",
      type: "protocol.agent.started",
      data: { actionID: input.action.id, agent: selected.agent.name, childSessionID: child.id, snapshot: gate.snapshot, observability: gate.observability },
    })
    await SessionDelegation.assign({
      action: input.action,
      agent: selected.agent.name,
      childID: child.id,
      metadata: gate,
      messageID: input.messageID,
      parentAgent: input.parentAgent,
      runID: input.runID,
      sessionID: input.sessionID,
    })
    setTimeout(() => {
      SessionPrompt.resolvePromptParts(task(input.action, input.prompt, selected.agent.name))
        .then((parts) =>
          SessionPrompt.prompt({
            sessionID: child.id,
            agent: selected.agent.name,
            model: {
              providerID: input.model.providerID,
              modelID: input.model.id,
            },
            parts,
          }))
        .then((msg) => SessionDelegation.finish({
          action: input.action,
          agent: selected.agent.name,
          childID: child.id,
          messageID: input.messageID,
          parentAgent: input.parentAgent,
          parentID: input.sessionID,
          result: msg,
          runID: input.runID,
        }))
        .catch((err) => SessionDelegation.fail({
          action: input.action,
          agent: selected.agent.name,
          childID: child.id,
          messageID: input.messageID,
          parentAgent: input.parentAgent,
          parentID: input.sessionID,
          runID: input.runID,
          error: err,
        }))
    }, 0)
    return {
      title: input.action.title,
      output: [
        `Delegated to ${selected.agent.name}.`,
        `Child session: ${child.id}`,
        "The parent session will resume automatically when the child result is available.",
      ].join("\n"),
      metadata: { agentID: selected.agent.name, childSessionID: child.id, delegated: true },
    }
  }

  async function fallback(
    action: AgentProtocol.Action,
    parent: string,
    trigger: string,
    gate?: ReturnType<typeof AgentDelegation.runtime>,
  ): Promise<{ ok: true; agent: Agent.Info } | { ok: false; error: string; metadata?: ReturnType<typeof AgentDelegation.runtime> }> {
    const selected = await agent(action, parent)
    const meta = gate ? undefined : await AgentDelegation.meta(action.executor.target).catch(() => undefined)
    const trig = action.executor.type === "agent" && action.executor.target === parent ? "no_specialist_match" : trigger
    const plan = gate?.collaboration ?? (selected.ok ? undefined : AgentDelegation.runtime({
      agent: action.executor.target,
      meta,
      action,
      trigger: trig,
    }).collaboration)
    for (const item of (plan?.items ?? []).filter((item) => item.edge_kind === "fallback")) {
      const next = await agent({
        ...action,
        executor: {
          ...action.executor,
          target: item.target,
        },
      }, parent)
      if (next.ok && (!selected.ok || next.agent.name !== selected.agent.name)) return next
    }
    if (selected.ok) return selected
    return { ...selected, metadata: gate }
  }

  async function agent(action: AgentProtocol.Action, parent: string): Promise<{ ok: true; agent: Agent.Info } | { ok: false; error: string }> {
    const agents = AgentDelegation.list(await Agent.list(), parent)
    const found =
      action.executor.target === "auto"
        ? AgentProtocolExecutor.select(action, agents.map((item) => ({
            id: item.name,
            entry: item.entry,
            capability: item.capability,
          })))?.id
        : agents.find((item) => item.name === action.executor.target)?.name
    if (!found) return { ok: false as const, error: `Protocol agent not available from ${parent}: ${action.executor.target}` }
    const selected = await Agent.get(found)
    if (!selected) return { ok: false as const, error: `Protocol agent not found: ${found}` }
    if (AgentDelegation.visible(selected, parent)) return { ok: true as const, agent: selected }
    return { ok: false as const, error: `Protocol agent not available from ${parent}: ${selected.name}` }
  }

  function task(action: AgentProtocol.Action, prompt: string | undefined, agent: string) {
    return [
      `Please handle this delegated task: ${action.title}.`,
      "Treat the task block below as your initial task for this session.",
      "",
      "When you are done, return the result for the parent session. Include what you did, important findings, changed files, test results, blockers, and whether the task goal is complete.",
      policy(action.result_policy),
      "",
      "<task>",
      prompt ?? text(action.input) ?? action.description ?? action.reason ?? action.title,
      "</task>",
    ].join("\n")
  }

  function policy(input: AgentProtocol.Action["result_policy"]) {
    if (input === "summary") return "Keep the result concise and focused on the outcome."
    if (input === "structured") return "Use a structured result with clear sections or bullets."
    if (input === "full") return "Include the full relevant details needed by the parent session."
    if (input === "on_failure") return "Keep the result brief unless the task fails; if it fails, include the failure details and next step."
    if (input === "on_demand") return "Keep the result brief and mention where more detail is available if needed."
    return "Adapt the level of detail to the task complexity and risk."
  }

  async function completeAssigned(input: {
    messageID: MessageID
    output: string
    sessionID: SessionID
    status: "completed" | "failed"
  }) {
    const item = await assignment(input.sessionID)
    await SessionDelegation.complete({
      ...input,
      ...(item
        ? {
            metadata: AgentDelegation.complete({
              agent: item.agent,
              meta: await AgentDelegation.meta(item.agent).catch(() => undefined),
              result: {
                content: input.output,
                source: item.agent,
              },
              status: input.status,
            }),
          }
        : {}),
    })
  }

  async function assignment(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    const ctx = session.dsl_context && typeof session.dsl_context === "object" && !Array.isArray(session.dsl_context) ? session.dsl_context : {}
    const protocol = ctx.protocol && typeof ctx.protocol === "object" && !Array.isArray(ctx.protocol) ? ctx.protocol as Record<string, unknown> : {}
    const item = protocol.delegation && typeof protocol.delegation === "object" && !Array.isArray(protocol.delegation) ? protocol.delegation as Record<string, unknown> : {}
    if (item.type !== "agent.delegation.assignment") return
    if (typeof item.agent !== "string") return
    return {
      agent: item.agent,
    }
  }

  async function completionLog(input: {
    agent: string
    complete: ReturnType<typeof AgentDelegation.complete>
    messageID: MessageID
    sessionID: SessionID
  }) {
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.messageID,
      level: input.complete.status === "completed" ? "info" : "warn",
      type: input.complete.validation.status === "valid" ? "agent.metadata.output_validated" : "agent.metadata.output_validation_failed",
      data: {
        agent: input.agent,
        status: input.complete.status,
        artifacts: input.complete.artifacts,
        validation: input.complete.validation,
        completion: input.complete.completion,
      },
    })
    if (input.complete.status === "completed") return
    const meta = await AgentDelegation.meta(input.agent).catch(() => undefined)
    const msgs = AgentDelegation.messages({ meta, event: "output_validation_failed" })
    if (!msgs.records.length && !msgs.diagnostics.length) return
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.messageID,
      level: "warn",
      type: "agent.metadata.messages",
      data: {
        agent: input.agent,
        event: "output_validation_failed",
        records: msgs.records,
        diagnostics: msgs.diagnostics,
      },
    })
  }

  async function followup(input: {
    agent: string
    complete: ReturnType<typeof AgentDelegation.complete>
    messageID: MessageID
    sessionID: SessionID
  }) {
    if (!input.complete.followup?.items.length) return
    const session = await Session.get(input.sessionID)
    const ctx = session.dsl_context && typeof session.dsl_context === "object" && !Array.isArray(session.dsl_context) ? session.dsl_context : {}
    const prev = ctx.protocol && typeof ctx.protocol === "object" && !Array.isArray(ctx.protocol) ? ctx.protocol as Record<string, unknown> : {}
    const vals = Array.isArray(prev.metadata_followups) ? prev.metadata_followups : []
    await Session.setDslContext({
      sessionID: input.sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          metadata_followups: [
            ...vals,
            {
              agent: input.agent,
              message_id: input.messageID,
              status: input.complete.status,
              validation: input.complete.validation.status,
              completion: input.complete.completion.status,
              plan: input.complete.followup,
              created_at: Date.now(),
            },
          ],
        },
      },
    })
  }

  function text(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return
    const value = input as Record<string, unknown>
    for (const key of ["prompt", "description", "task", "request", "message"]) {
      const item = value[key]
      if (typeof item === "string" && item.trim()) return item
    }
  }

  function object(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {} as Record<string, unknown>
    return input as Record<string, unknown>
  }

  async function tool(input: {
    action: AgentProtocol.Action
    prompt: string | undefined
    sessionID: SessionID
    messageID: MessageID
    agent: string
    abort: AbortSignal
    messages: MessageV2.WithParts[]
    model: LLM.StreamInput["model"]
    runtimeTools: RuntimeTools.Info | undefined
  }): Promise<AgentProtocolExecutor.ToolResult> {
    if (input.action.executor.type !== "tool") {
      return {
        title: input.action.title,
        output: input.prompt ? `${input.action.operation}: ${input.prompt}` : `${input.action.operation}: ${input.action.title}`,
        metadata: {},
      }
    }
    const found = pick(input.action, input.prompt, input.runtimeTools)
    if (!found.ok) {
      return {
        title: input.action.title,
        output: found.error,
        metadata: {
          blocked: true,
        },
      }
    }
    const results: {
      callID: string
      tool: string
      title: string
      output: string
      metadata: Record<string, unknown>
    }[] = []
    for (const item of found.items) {
      const callID = found.items.length === 1 ? `call_${input.action.id}` : `call_${input.action.id}_${results.length + 1}`
      const now = Date.now()
      const args = item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args as Record<string, unknown> : {}
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: input.messageID,
        sessionID: input.sessionID,
        type: "tool",
        tool: item.id,
        callID,
        state: {
          status: "running",
          input: args,
          time: {
            start: now,
          },
        },
        metadata: {
          protocol: true,
          actionID: input.action.id,
        },
      }) as MessageV2.ToolPart
      await SessionLog.emit({
        sessionID: input.sessionID,
        messageID: input.messageID,
        level: "info",
        type: "tool.start",
        data: { partID: part.id, callID, tool: item.id, input: item.args, protocol: true, actionID: input.action.id },
      })
      try {
        const out = await input.runtimeTools?.execute(item.id, item.args, {
          toolCallId: callID,
          abortSignal: input.abort,
        } as never) as {
          title: string
          output: string
          metadata: Record<string, unknown>
          attachments?: MessageV2.FilePart[]
        }
        await Session.updatePart({
          ...part,
          state: {
            status: "completed",
            input: args,
            output: out.output,
            title: out.title,
            metadata: out.metadata,
            time: {
              start: now,
              end: Date.now(),
            },
            attachments: out.attachments,
          },
        })
        await SessionLog.emit({
          sessionID: input.sessionID,
          messageID: input.messageID,
          level: "info",
          type: "tool.finish",
          data: { partID: part.id, callID, tool: item.id, title: out.title, outputBytes: out.output.length, protocol: true, actionID: input.action.id },
        })
        results.push({
          callID,
          tool: item.id,
          title: out.title,
          output: out.output,
          metadata: out.metadata,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await Session.updatePart({
          ...part,
          state: {
            status: "error",
            input: args,
            error: msg,
            metadata: { protocol: true, actionID: input.action.id },
            time: {
              start: now,
              end: Date.now(),
            },
          },
        })
        await SessionLog.emit({
          sessionID: input.sessionID,
          messageID: input.messageID,
          level: "error",
          type: "tool.error",
          data: { partID: part.id, callID, tool: item.id, error: msg, protocol: true, actionID: input.action.id },
        })
        results.push({
          callID,
          tool: item.id,
          title: item.id,
          output: msg,
          metadata: { failed: true },
        })
      }
    }
    const blocked = results.find((item) => item.metadata.blocked === true)
    if (blocked) {
      return {
        title: input.action.title,
        output: blocked.output,
        metadata: {
          callID: blocked.callID,
          tool: blocked.tool,
          blocked: true,
        },
      }
    }
    if (results.length === 1) {
      const result = results[0]!
      return {
        title: result.title,
        output: result.output,
        metadata: {
          ...result.metadata,
          callID: result.callID,
          tool: result.tool,
        },
      }
    }
    return {
      title: input.action.title,
      output: results.map((item) => `## ${item.tool}: ${item.title}\n${item.output}`).join("\n\n"),
      metadata: {
        failed: results.some((item) => item.metadata.failed === true),
        toolCallIDs: results.map((item) => item.callID),
        tools: results.map((item) => item.tool),
      },
    }
  }

  type Picked = { id: string; args: unknown }
  type PickResult = { ok: true; items: Picked[] } | { ok: false; error: string }

  function pick(
    action: AgentProtocol.Action,
    prompt: string | undefined,
    runtime: RuntimeTools.Info | undefined,
  ): PickResult {
    const target = action.executor.target
    if (!runtime) {
      return {
        ok: false,
        error: "Protocol runtime tools were not resolved for this turn.",
      }
    }
    if (target === "auto") {
      return {
        ok: false,
        error: `Action '${action.id}' is underspecified: tool executor target must be a concrete tool id from the available tool catalog.`,
      }
    }
    const found = runtime.catalog.find((item) => item.id === target)
    if (!found) {
      return {
        ok: false,
        error: `Action '${action.id}' references unavailable tool '${target}'.`,
      }
    }
    if (action.input) {
      return { ok: true, items: [{ id: found.id, args: action.input }] }
    }
    const args = legacy(target, action, prompt)
    if (args) {
      return { ok: true, items: [{ id: found.id, args }] }
    }
    return {
      ok: false,
      error: `Action '${action.id}' is underspecified: tool action must include an 'input' object matching the '${target}' tool schema.`,
    }
  }

  function legacy(target: string, action: AgentProtocol.Action, prompt: string | undefined) {
    if (target === "read") {
      const file = pathref(action, prompt)
      if (file) return { filePath: file, limit: 220 }
      return
    }
    if (target === "grep") {
      const text = hint(action, prompt)
      const pat = pattern(text)
      if (pat) return { pattern: pat, include: include(text) }
      return
    }
    if (target === "glob") {
      const pat = glob(hint(action, prompt))
      if (pat) return { pattern: pat }
      return
    }
  }

  function pathref(action: AgentProtocol.Action, prompt: string | undefined) {
    const ref = action.context_refs.find((item) => /[/\\.]|README|package|config/i.test(item))
    if (ref) return ref
    const text = hint(action, prompt)
    return (
      text.match(/`([^`]+\.[a-zA-Z0-9]+)`/)?.[1] ??
      text.match(/(?:^|\s)(\/[\w./-]+\.[a-zA-Z0-9]+)(?:\s|$|[,，。])/u)?.[1] ??
      text.match(/(?:^|\s)([\w./-]+\.[a-zA-Z0-9]+)(?:\s|$|[,，。])/u)?.[1]
    )
  }

  function hint(action: AgentProtocol.Action, prompt: string | undefined) {
    return [
      ...action.context_refs,
      action.prompt_ref?.startsWith("md:") ? undefined : action.prompt_ref,
      action.title,
      action.description,
      action.reason,
      prompt,
    ]
      .filter((item) => item)
      .join("\n")
  }

  function pattern(prompt: string | undefined) {
    return prompt?.match(/`([^`]+)`/)?.[1] ?? prompt?.match(/pattern:\s*([^\n]+)/i)?.[1]?.trim()
  }

  function include(prompt: string | undefined) {
    return prompt?.match(/include:\s*([^\n]+)/i)?.[1]?.trim()
  }

  function glob(prompt: string | undefined) {
    return (
      prompt?.match(/`([^`]*[*?][^`]*)`/)?.[1] ??
      prompt?.match(/(?:^|\s)([\w./*-]*[*?][\w./*-]*)(?=\s|$|[,，。])/u)?.[1]
    )
  }

  async function project(sessionID: SessionID, run: AgentProtocol.Result) {
    await Storage.write(["session_protocol_run", sessionID, run.run_id], run)
    const session = await Session.get(sessionID)
    const ctx = session.dsl_context && typeof session.dsl_context === "object" && !Array.isArray(session.dsl_context) ? session.dsl_context : {}
    const prev = ctx.protocol && typeof ctx.protocol === "object" && !Array.isArray(ctx.protocol) ? ctx.protocol as Record<string, unknown> : {}
    const runs = Array.isArray(prev.runs) ? prev.runs : []
    await Session.setDslContext({
      sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          current: run.run_id,
          runs: [
            ...runs.filter((item) => !(item && typeof item === "object" && "runID" in item && item.runID === run.run_id)),
            {
              runID: run.run_id,
              title: run.title ?? "Protocol run",
              status: run.status,
              total: run.actions.length,
              completed: run.actions.filter((item) => item.status === "completed").length,
              actions: run.actions.map((item) => ({
                id: item.id,
                title: item.title,
                operation: item.operation,
                executor: item.executor,
                status: item.status,
                summary: item.summary.slice(0, 4000),
                error: item.error?.slice(0, 4000),
                tool_call_ids: item.tool_call_ids,
                duration_ms: item.duration_ms,
                time: item.time,
              })),
              result_ref: ["session_protocol_run", sessionID, run.run_id].join("/"),
              time: run.time,
              metrics: run.metrics,
            },
          ],
        },
      },
    })
  }

  async function pending(sessionID: SessionID, runID: string, declaration: AgentProtocol.Declaration) {
    const now = Date.now()
    const actions = declaration.payload.type === "action_graph" ? declaration.payload.actions : []
    const session = await Session.get(sessionID)
    const ctx = session.dsl_context && typeof session.dsl_context === "object" && !Array.isArray(session.dsl_context) ? session.dsl_context : {}
    const prev = ctx.protocol && typeof ctx.protocol === "object" && !Array.isArray(ctx.protocol) ? ctx.protocol as Record<string, unknown> : {}
    const runs = Array.isArray(prev.runs) ? prev.runs : []
    await Session.setDslContext({
      sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          current: runID,
          runs: [
            ...runs.filter((item) => !(item && typeof item === "object" && "runID" in item && item.runID === runID)),
            {
              runID,
              title: declaration.title ?? "Protocol run",
              status: "running",
              total: actions.length,
              completed: 0,
              actions: actions.map((item) => ({
                id: item.id,
                title: item.title,
                operation: item.operation,
                executor: item.executor,
                status: "pending",
                summary: "",
                tool_call_ids: [],
                duration_ms: 0,
                time: {
                  started: now,
                },
              })),
              time: {
                started: now,
              },
              metrics: {
                actions: actions.length,
                internal_tool_calls: 0,
                direct_model_tool_calls: 0,
                model_visible_bytes: 0,
                raw_output_bytes: 0,
                duration_ms: 0,
              },
            },
          ],
        },
      },
    })
  }

  async function workflow(chat: SessionProcessor.Info, stream: LLM.StreamInput): Promise<SessionProcessor.Result> {
    const text = stream.messages
      .slice()
      .reverse()
      .flatMap((msg) => (msg.role === "user" && typeof msg.content === "string" ? [msg.content] : []))[0]
      ?.trim()
    const sessionID = SessionID.make(stream.sessionID)
    const state = await WorkflowExecutor.status(sessionID)
    let part: PartID | undefined
    let action: "started" | "continued" | "resumed" | "permission" | undefined
    const next = state?.pause
      ? state.pause.type === "waiting_permission"
        ? await (async () => {
            action = "permission"
            return permission(sessionID, state, text)
          })()
        : await (async () => {
            action = "resumed"
            return WorkflowExecutor.resume({
              sessionID,
              variables: input(text),
            })
          })()
      : state?.status === "active"
        ? await (async () => {
            action = "continued"
            part = await progress(chat, state, action)
            return WorkflowExecutor.continueRun({
              sessionID,
              variables: input(text),
              agent: stream.agent.name,
              abort: stream.abort,
            })
          })()
        : state?.status === "completed" || state?.status === "error" || state?.status === "aborted"
          ? undefined
          : await (async () => {
              action = "started"
              return start(sessionID, text)
            })()

    if (!next) return chat.process(stream).then((result) => generated(chat, stream, result))
    await output(chat, next, part, action)
    return "stop"
  }

  async function permission(sessionID: SessionID, state: WorkflowState.Info, text: string | undefined) {
    const value = text?.trim().toLowerCase()
    if (!value) return state
    if (/^(approve|approved|yes|y)\b/.test(value) || value.startsWith("同意") || value.startsWith("批准")) {
      return WorkflowExecutor.resume({ sessionID, approved: true })
    }
    if (/^(reject|deny|denied|no|n)\b/.test(value) || value.startsWith("拒绝") || value.startsWith("否")) {
      return WorkflowExecutor.resume({ sessionID, approved: false })
    }
    return state
  }

  async function start(sessionID: SessionID, text: string | undefined) {
    const workflow = (await WorkflowExecutor.list()).find((item) => text?.split(/\s+/).includes(item.id))
    if (!workflow) return
    return WorkflowExecutor.run({ sessionID, workflowID: workflow.id, variables: input(text) })
  }

  async function generated(chat: SessionProcessor.Info, stream: LLM.StreamInput, result: SessionProcessor.Result) {
    if (chat.message.error) return result
    if (!chat.message.finish || ["tool-calls", "unknown"].includes(chat.message.finish)) return result
    const workflow = await detect(chat.message.id)
    if (!workflow) return result

    await persist(workflow.data)
    const state = await WorkflowExecutor.run({
      sessionID: SessionID.make(stream.sessionID),
      workflowID: workflow.workflow.id,
      variables: input(
        stream.messages
          .slice()
          .reverse()
          .flatMap((msg) => (msg.role === "user" && typeof msg.content === "string" ? [msg.content] : []))[0]
          ?.trim(),
      ),
    })
    await output(chat, state, undefined, "started")
    return "stop"
  }

  async function detect(messageID: MessageID) {
    const text = (await MessageV2.parts(messageID))
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    for (const data of candidates(text)) {
      const parsed = parse(data)
      if (parsed) return parsed
    }
  }

  function candidates(text: string) {
    const result: string[] = []
    const blocks = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)
    for (const block of blocks) result.push(block[1]!.trim())
    result.push(text.trim())
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && end > start) result.push(text.slice(start, end + 1))
    return [...new Set(result)].filter((item) => item.length > 0)
  }

  function parse(data: string): { data: unknown; workflow: WorkflowParser.Definition } | undefined {
    try {
      const json = JSON.parse(data)
      return { data: json, workflow: WorkflowParser.parse(json) }
    } catch {
      return undefined
    }
  }

  async function persist(data: unknown) {
    const workflow = WorkflowParser.parse(data)
    await Filesystem.writeJson(path.join(Instance.directory, ".opencode", "workflows", `${workflow.id}.json`), data)
    return workflow
  }

  function input(text: string | undefined) {
    if (!text) return {}
    return {
      input: text,
      prompt: text,
      request: text,
      answer: text,
    }
  }

  type Action = "started" | "continued" | "resumed" | "permission" | "updated"

  async function progress(chat: SessionProcessor.Info, state: WorkflowState.Info, action: Action) {
    const msg = chat.message
    const fmt = format(state, action)
    const part = await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "text",
      text: fmt.text,
      metadata: fmt.metadata,
      time: {
        start: Date.now(),
      },
    })
    return part.id
  }

  async function output(chat: SessionProcessor.Info, state: WorkflowState.Info, partID?: PartID, action: Action = "updated") {
    const msg = chat.message
    const fmt = format(state, action)
    await Session.updatePart({
      id: partID ?? PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "text",
      text: fmt.text,
      metadata: fmt.metadata,
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    })
    msg.finish = state.status === "error" ? "error" : "stop"
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
  }

  function format(state: WorkflowState.Info, action: Action) {
    const statuses = Object.values(state.statuses)
    const counts = {
      completed: statuses.filter((item) => item === "completed").length,
      failed: statuses.filter((item) => item === "error").length,
      skipped: statuses.filter((item) => item === "skipped" || item === "cancelled").length,
      pending: statuses.filter((item) => item === "pending").length,
      running: statuses.filter((item) => item === "running").length,
    }
    const label =
      action === "started"
        ? "Workflow started"
        : action === "continued"
          ? "Workflow continued"
          : action === "resumed"
            ? "Workflow resumed"
            : action === "permission"
              ? "Workflow permission updated"
              : "Workflow updated"
    return {
      text: `${label}: ${state.workflowName || state.workflowID}\n${summary(state)}`,
      metadata: {
        kind: "workflow",
        action,
        workflow: {
          runID: state.runID,
          workflowID: state.workflowID,
          workflowName: state.workflowName,
          status: state.status,
          current: state.current,
          step: state.step + 1,
          total: state.total,
          counts,
        },
      },
    }
  }

  function summary(state: WorkflowState.Info) {
    const head = `Workflow ${state.workflowName || state.workflowID}: ${state.status}`
    const progress = `Step ${state.step + 1}/${state.total}: ${state.current || "none"}`
    if (state.status === "completed") return `${head}\n${progress}\nCompleted steps: ${state.completed.join(", ") || "none"}.`
    if (state.status === "waiting_user" || state.status === "waiting_permission") {
      return `${head}\n${progress}\n${state.pause?.reason ?? "Workflow is paused."}`
    }
    if (state.status === "error") return `${head}\n${progress}\n${state.error ?? "Workflow failed."}`
    return `${head}\n${progress}`
  }
}
