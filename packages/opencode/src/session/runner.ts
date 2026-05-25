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
import { Identifier } from "@/id/id"
import { RuntimeTools } from "./runtime-tools"

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
        log.info("dispatch", { runner, agent: stream.agent.name })
        return dispatch(stream, {
          chat: () => chat.process(stream),
          workflow: () => workflow(chat, stream),
          protocol: () => protocol(chat, stream),
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
    const parsed = native ? { ok: true as const, value: native } : AgentProtocolParser.parse(text)
    const partial = chat.message.finish === "length"
    const first = parsed.ok || partial || parsed.error.code === "multiple_blocks" ? undefined : AgentProtocolParser.first(text)
    const fixed = parsed.ok || partial ? undefined : first?.ok ? first.value : retry > 0 ? recover(text, stream) : undefined
    const valid = parsed.ok && !partial
    const problem = partial
      ? { code: "partial_output", message: "Model output stopped because it reached the output length limit." }
      : parsed.ok
        ? undefined
        : parsed.error
    if (!valid && !fixed && retry < 1) {
      const sessionID = SessionID.make(stream.sessionID)
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
          reason: partial ? "partial_protocol_output" : pseudo(text) ? "non_protocol_tool_call" : "non_protocol_output",
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
              "Your previous response violated Agent Protocol DSL v1.",
              pseudo(text)
                ? "You output a provider-specific textual tool call instead of `agent.protocol.output`."
                : partial
                  ? "Your output was cut off by the model output length limit."
                  : chat.message.finish === "tool-calls"
                    ? `You must call the native ${LLM.PROTOCOL_OUTPUT_TOOL} tool exactly once.`
                  : problem?.code === "multiple_blocks"
                    ? "You output multiple Agent Protocol packages in one response."
                    : "You did not output a valid `agent.protocol.output` package.",
              `Retry now by calling ${LLM.PROTOCOL_OUTPUT_TOOL} exactly once.`,
              "Keep the package small: output only the next necessary action set, preferably no more than 8 actions.",
              "If more work is needed after this package executes, wait for the runtime observation and continue in the next turn.",
              "Do not output minimax:tool_call, [TOOL_CALL], XML invoke tags, fake tool results, fenced JSON, or plain Markdown-only answers.",
              "If execution is needed, use `intent: \"execute\"` with concrete `actions`, tools from Available Protocol Tools, and valid `input` JSON.",
              "If no execution is needed, use `intent: \"respond\"` and put the Markdown answer in `message`.",
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

    const sessionID = SessionID.make(stream.sessionID)
    await Promise.all(
      parts.flatMap((part) => {
        if (part.type === "text" && part.text.includes("agent-protocol")) {
          const show = visible(part.text, valid ? parsed.value : first?.ok ? first.value : undefined)
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
    const msg = native ? parsedValue.declaration.message?.trim() : ""
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
      return "stop"
    }
    const run = await execute({ chat, stream, sessionID, parsed: parsedValue, recovered: !!fixed })
    const raw = await Session.updatePart({
      id: PartID.ascending(),
      messageID: chat.message.id,
      sessionID,
      type: "text",
      text: JSON.stringify(observation(run), null, 2),
      synthetic: true,
      ignored: true,
      metadata: {
        kind: "protocol",
        action: run.status,
        protocol: run,
      },
      time: { start: Date.now(), end: Date.now() },
    })
    await project(sessionID, run)
    chat.message.finish = run.status === "failed" ? "error" : "stop"
    chat.message.time.completed = Date.now()
    await Session.updateMessage(chat.message)
    if (run.status !== "blocked") {
      await final({
        stream,
        run,
        exchange: observe(run),
      }, 0)
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
    const run = await AgentProtocolExecutor.run({
      declaration: input.parsed.declaration,
      sections: input.parsed.sections,
      runID,
      agents: (await Agent.list()).map((item) => ({
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
          : Promise.resolve(undefined),
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

  async function final(input: {
    stream: LLM.StreamInput
    run: AgentProtocol.Result
    exchange: string
  }, retry: number) {
    const msg = await Session.updateMessage({
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
    } as MessageV2.Assistant)
    const processor = SessionProcessor.create({
      assistantMessage: msg as MessageV2.Assistant,
      sessionID: SessionID.make(input.stream.sessionID),
      model: input.stream.model,
      abort: input.stream.abort,
    })
    const prompt = [
      "You are writing the final user-facing answer after an Agent Protocol DSL run.",
      "This is not an execution turn. The runtime has already executed every available action.",
      `Use only the conversation turns below, then answer the user.`,
      `You may call ${LLM.PROTOCOL_OUTPUT_TOOL} with intent \`respond\`, or output ordinary Markdown directly.`,
      "Only use `intent: \"execute\"` if another runtime action is truly required.",
      "Never write, request, or simulate business tool calls. Never output provider-specific textual tool calls.",
      "The full conversation history is preserved. Resolve references like \"these errors\", \"continue\", or \"fix them\" from the earlier turns.",
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
      toolChoice: { type: "auto" } as never,
      messages: [
        ...input.stream.messages,
        {
          role: "user",
          content: [
            "Agent Protocol runtime observation for the latest execution:",
            "<agent-protocol-observation>",
            input.exchange,
            "</agent-protocol-observation>",
          ].join("\n"),
        },
      ],
    })
    const parsed = await protocolOutput(msg.id)
    if (parsed) {
      const sessionID = SessionID.make(input.stream.sessionID)
      if (parsed.declaration.intent === "execute") {
        const run = await execute({ chat: processor, stream: input.stream, sessionID, parsed, recovered: false })
        const raw = await Session.updatePart({
          id: PartID.ascending(),
          messageID: processor.message.id,
          sessionID,
          type: "text",
          text: JSON.stringify(observation(run), null, 2),
          synthetic: true,
          ignored: true,
          metadata: {
            kind: "protocol",
            action: run.status,
            protocol: run,
          },
          time: { start: Date.now(), end: Date.now() },
        })
        await project(sessionID, run)
        if (run.status !== "blocked") {
          await final({
            stream: input.stream,
            run,
            exchange: observe(run),
          }, 0)
          return
        } else {
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
        }
      } else {
        await response({
          chat: processor,
          sessionID,
          parsed,
        })
      }
    } else {
      const text = await textOf(msg.id)
      await SessionLog.emit({
        sessionID: SessionID.make(input.stream.sessionID),
        messageID: msg.id,
        level: pseudo(text) ? "warn" : "info",
        type: pseudo(text) ? "protocol.final.plain_tool_syntax" : "protocol.final.plain",
        data: { runID: input.run.run_id, textBytes: text.length },
      })
    }
    await SessionLog.emit({
      sessionID: SessionID.make(input.stream.sessionID),
      messageID: msg.id,
      level: "info",
      type: "protocol.final.completed",
      data: { runID: input.run.run_id },
    })
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

  async function protocolOutput(messageID: MessageID) {
    const native = await nativeOutput(messageID)
    if (native) return native
    const parts = await MessageV2.parts(messageID)
    const text = parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    const parsed = AgentProtocolParser.parse(text)
    if (!parsed.ok) return
    await Promise.all(
      parts.flatMap((part) => {
        if (part.type === "text" && part.text.includes("agent-protocol")) {
          const show = visible(part.text, parsed.value)
          if (show.trim().length > 0) {
            return [
              Session.updatePart({
                ...part,
                text: show,
                metadata: {
                  ...part.metadata,
                  kind: "protocol_intro",
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
              },
            }),
          ]
        }
        return []
      }),
    )
    return parsed.value
  }

  async function nativeOutput(messageID: MessageID): Promise<AgentProtocolParser.Parsed | undefined> {
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
        declaration: AgentProtocol.parse(input),
        sections: {},
        raw: JSON.stringify(input),
      }
    } catch {
      return
    }
  }

  function observation(run: AgentProtocol.Result) {
    return {
      type: "agent.protocol.observation",
      version: "1",
      run_id: run.run_id,
      status: run.status,
      title: run.title,
      actions: run.actions.map((item) => ({
        id: item.id,
        title: item.title,
        operation: item.operation,
        status: item.status,
        summary: item.summary,
        error: item.error,
      })),
      metrics: run.metrics,
      next: "decide",
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

  function observe(run: AgentProtocol.Result) {
    const status =
      run.status === "completed"
        ? "已完成。"
        : run.status === "blocked"
          ? "已阻塞。"
          : "已失败。"
    const actions = run.actions
      .map((item, idx) =>
        [
          `${idx + 1}. 动作：${item.title}`,
          `   操作：${item.operation}`,
          `   状态：${item.status}`,
          item.summary ? `   结果：${item.summary}` : "",
          item.error ? `   失败原因：${item.error}` : "",
          item.tool_call_ids.length ? `   证据：${item.tool_call_ids.map((id) => `artifact://${id}`).join(", ")}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      )
      .join("\n\n")
    return [
      `执行状态：${status}`,
      "",
      "执行的动作和结果：",
      actions || "没有执行动作。",
      "",
      "下一步：",
      "请根据全部输入判断下一轮 intent。若信息足够，请使用 intent: \"respond\" 并引用 `md:response`；若还需要更多信息，请使用 intent: \"execute\"。",
    ].join("\n")
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

  function goal(stream: LLM.StreamInput) {
    const last = stream.messages.findLast((item) => item.role === "user")
    if (!last) return ""
    if (typeof last.content === "string") return last.content
    if (!Array.isArray(last.content)) return ""
    return last.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
  }

  function recover(text: string, stream: LLM.StreamInput): AgentProtocolParser.Parsed | undefined {
    if (!pseudo(text)) return
    const invoked = invoke(text)
    if (invoked.length > 0) {
      return {
        declaration: {
          type: "agent.protocol",
          version: "1",
          intent: "execute",
          persist: false,
          title: "Recover textual tool request",
          execution: { strategy: "sequential" },
          payload: {
            type: "action_graph",
            actions: invoked.map((item, idx) => ({
              type: "action" as const,
              id: `recover-${idx + 1}`,
              title: `${item.name} ${Object.values(item.input).filter((value) => typeof value === "string")[0] ?? "request"}`,
              operation: item.name,
              executor: { type: "tool" as const, target: item.name, capabilities: ["repo"] },
              input: item.input,
              depends_on: [],
              context_refs: [],
              result_policy: "summary" as const,
            })),
          },
        },
        sections: { goal: goal(stream) },
        raw: text,
      }
    }
    const refs = [...text.matchAll(/(?:^|\s)(\/?[\w./*-]+\.(?:html|js|ts|tsx|jsx|vue|json|md|css))(?=\s|$|[,，。])/giu)]
      .map((item) => item[1])
      .filter((item): item is string => !!item)
    const actions = (refs.length ? refs : ["**/*.{html,js,ts,tsx,jsx,vue,json,md,css}"]).map((ref, idx) => {
      const globbed = /[*?]/.test(ref)
      const file = globbed && ref.startsWith("/*.") ? `**${ref}` : ref
      return {
        type: "action" as const,
        id: `recover-${idx + 1}`,
        title: globbed ? `Find ${file}` : `Read ${file}`,
        operation: globbed ? "inspect" : "read",
        executor: { type: "tool" as const, target: globbed ? "glob" : "read", capabilities: ["repo"] },
        input: globbed ? { pattern: file } : { filePath: file, limit: 220 },
        depends_on: [],
        context_refs: [],
        prompt_ref: file,
        result_policy: "summary" as const,
      }
    })
    return {
      declaration: {
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        persist: false,
        title: "Recover textual tool request",
        execution: { strategy: "sequential" },
        payload: {
          type: "action_graph",
          actions,
        },
      },
      sections: { goal: goal(stream) },
      raw: text,
    }
  }

  function invoke(text: string) {
    return [...text.matchAll(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi)]
      .map((item) => {
        const name = item[1]?.trim().toLowerCase()
        const body = item[2] ?? ""
        if (!name) return
        const params = Object.fromEntries(
          [...body.matchAll(/<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi)]
            .map((param) => [param[1]?.trim(), param[2]?.trim()])
            .filter((param): param is [string, string] => Boolean(param[0])),
        )
        if (name === "glob" && typeof params.pattern === "string") {
          return { name, input: clean({ pattern: params.pattern, path: params.path }) }
        }
        if (name === "grep" && typeof params.pattern === "string") {
          return { name, input: clean({ pattern: params.pattern, path: params.path, include: params.include }) }
        }
        if (name === "read" && typeof params.filePath === "string") {
          return { name, input: clean({ filePath: params.filePath, offset: number(params.offset), limit: number(params.limit) }) }
        }
        if (name === "bash" && typeof params.command === "string") {
          return { name, input: clean({ command: params.command, timeout: number(params.timeout), workdir: params.workdir, description: params.description }) }
        }
        return
      })
      .filter((item): item is { name: string; input: Record<string, unknown> } => !!item)
  }

  function clean(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter((item) => item[1] !== undefined))
  }

  function number(input: string | undefined) {
    if (!input) return
    const value = Number(input)
    if (Number.isFinite(value)) return value
  }

  function pseudo(text: string) {
    return /\bminimax:tool_call\b|<minimax:tool_call>|<invoke\s+name=|\[TOOL_CALL\]|\btool_call\b|\btool\s*=>/i.test(text)
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
              actions: run.actions,
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
