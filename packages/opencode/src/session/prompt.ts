import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { getRegistry } from "../agent/registry"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { RuntimeTools } from "./runtime-tools"
import { SessionResult } from "./result"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $ } from "bun"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@open-agent-harness/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { SessionRunner } from "./runner"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { SessionLog } from "./log"
import { LLM } from "./llm"
import { SessionTurn } from "./turn"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { decodeDataUrl } from "@/util/data-url"
import { Trace } from "@/observability/trace"
import { AgentEntry } from "@/agent/entry"
import { resolveInstructions } from "@/agent/instructions"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { ConflictError } from "@/storage/db"
import { ActionResult } from "./action-result"
import { RequestFooter } from "./request-footer"
import { SessionDelegation } from "./delegation"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  const MAX_AUTO_OVERFLOW_COMPACTIONS = 2
  const MAX_TOOL_CALLS = 1000
  const ACTION_RESULT_FAILURES = 3

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            messageID?: MessageID
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  export function assertNotBusy(sessionID: SessionID) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export function busy(sessionID: SessionID) {
    return !!state()[sessionID]
  }

  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    confirm: z.boolean().optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const enqueue = fn(PromptInput, async (input) => {
    const base = await Session.get(input.sessionID)
    const active = busy(input.sessionID)
    if (!active) {
      await SessionRevert.cleanup(base)
      await repair(base)
    }
    const session =
      !active && input.model && !equal(base.model, input.model)
        ? await Session.setModel({ sessionID: input.sessionID, model: input.model, confirm: input.confirm })
        : base

    const message = await createUserMessage(input, session)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (!active && permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    return message
  })

  export const prompt = fn(PromptInput, async (input) => {
    const message = await enqueue(input)
    if (input.noReply === true) return message
    return loop({ sessionID: input.sessionID, messageID: message.info.id })
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent && AgentEntry.mentionable(agent)) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: SessionID) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  function resume(sessionID: SessionID) {
    const s = state()
    if (!s[sessionID]) return

    return s[sessionID].abort.signal
  }

  export function cancel(sessionID: SessionID) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) {
      const status = SessionStatus.get(sessionID).type
      if (
        status === "completed" ||
        status === "terminal_reply" ||
        status === "user_completed" ||
        status === "archived" ||
        status === "failed" ||
        status === "error" ||
        status === "timeout"
      )
        return
      SessionStatus.set(sessionID, { type: "aborted" })
      return
    }
    match.abort.abort()
    match.callbacks.forEach((item) => item.reject(new Error("Session was aborted before queued user was processed.")))
    delete s[sessionID]
    SessionStatus.set(sessionID, { type: "aborted" })
    return
  }

  export const cancelQueuedMessage = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
    async (input) => {
      await Session.removeQueuedMessage(input)
      const entry = state()[input.sessionID]
      if (!entry) return true
      const keep = entry.callbacks.filter((item) => {
        if (item.messageID !== input.messageID) return true
        item.reject(new Error("Queued message was cancelled."))
        return false
      })
      entry.callbacks = keep
      return true
    },
  )

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function text(input: unknown) {
    if (typeof input === "string") return input
  }

  async function waiting(sessionID: SessionID) {
    const session = await Session.get(sessionID).catch(() => undefined)
    const ctx = object(session?.dsl_context)
    const protocol = object(ctx.protocol)
    const pending = object(protocol.pending_delegations)
    const ids = Object.keys(pending)
    const live = (
      await Promise.all(
        ids.map(async (id) => {
          const item = object(pending[id])
          const rec = await SessionResult.find({
            parentSessionID: sessionID,
            childSessionID: SessionID.make(id),
            runID: text(item.run_id),
            actionID: text(item.action_id),
          })
          if (rec) return
          if (ended(SessionStatus.get(SessionID.make(id)))) return
          return id
        }),
      )
    ).filter((id): id is string => typeof id === "string")
    if (live.length === ids.length) return live.length
    await Session.setDslContext({
      sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...protocol,
          pending_delegations: Object.fromEntries(live.map((id) => [id, pending[id]])),
        },
      },
    })
    return live.length
  }

  function ended(status: SessionStatus.Info) {
    return (
      status.type === "completed" ||
      status.type === "terminal_reply" ||
      status.type === "user_completed" ||
      status.type === "aborted" ||
      status.type === "failed" ||
      status.type === "blocked" ||
      status.type === "interrupted" ||
      status.type === "timeout" ||
      status.type === "error" ||
      status.type === "archived"
    )
  }

  async function finish(sessionID: SessionID, after: MessageID | undefined) {
    const s = state()
    const status = SessionStatus.get(sessionID)
    const entry = s[sessionID]
    if (!entry) return

    const queued = await next(sessionID)
    if (status.type === "error" || status.type === "timeout") {
      entry.callbacks
        .filter((item) => !item.messageID || item.messageID === after)
        .forEach((item) => item.reject(status))
      entry.callbacks = entry.callbacks.filter((item) => item.messageID && item.messageID !== after)
      if (!queued) {
        delete s[sessionID]
        return
      }
    }
    if (ended(status) && !queued) {
      delete s[sessionID]
      return
    }

    const pending = await waiting(sessionID)
    SessionStatus.set(
      sessionID,
      pending > 0
        ? { type: "waiting_child", message: `Waiting for ${pending} delegated child session${pending === 1 ? "" : "s"}.` }
        : { type: "completed" },
    )

    void resumeAfter(sessionID, after).catch((error) => {
      const callbacks = s[sessionID]?.callbacks
      if (!callbacks || callbacks.length === 0) return
      callbacks.forEach((item) => item.reject(error))
      delete s[sessionID]
    })
  }

  export const LoopInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    resume_existing: z.boolean().optional(),
  })
  export const loop = fn(LoopInput, async (input) => {
    return Trace.run("session.prompt.loop", { sessionID: input.sessionID }, () => loopInner(input))
  })

  async function loopInner(input: z.infer<typeof LoopInput>) {
    const { sessionID, resume_existing } = input

    const abort = resume_existing ? resume(sessionID) : start(sessionID)
    if (!abort) {
      const entry = state()[sessionID]
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ messageID: input.messageID, resolve, reject })
      })
    }

    let lastUserID: MessageID | undefined

    await using _ = defer(() => finish(sessionID, lastUserID))

    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined

    let step = 0
    let calls = 0
    let failures = 0
    await repair(await Session.get(sessionID))
    while (true) {
      const session = await Session.get(sessionID)
      SessionStatus.set(sessionID, { type: "running" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      const next = turn(msgs)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastFinished) break
      }

      if (!next) {
        log.info("exiting loop", { sessionID })
        break
      }
      const tasks = next.tasks
      const lastUser = await SessionTurn.run({ user: next.info })
      if (!lastUser) continue
      lastUserID = lastUser.id
      const agentName = pref(session).agent ?? lastUser.agent
      const selected = pref(session).model ?? lastUser.model

      step++
      if (step === 1)
        void ensureTitle({
          session,
          modelID: selected.modelID,
          providerID: selected.providerID,
          history: msgs,
        }).catch((error) => log.error("failed to generate title", { error }))

      const model = await Provider.getModel(selected.providerID, selected.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
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
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        if (!taskAgent) throw new Error(`Agent not found: ${task.agent}`)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          async metadata(input) {
            part = (await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)) as MessageV2.ToolPart
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              workspaceID: session.workspaceID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID,
          messageID: assistantMessage.id,
        }))
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: "metadata" in part.state ? part.state.metadata : undefined,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: selected,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
          overflow: task.overflow,
        })
        if (result === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: agentName,
          model: selected,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await Agent.get(agentName)
      if (!agent) throw new Error(`Agent not found: ${agentName}`)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })
      const actionResult = context(session, agent)
      const footer = requestFooter({ session, agent, actionResult })

      const processor = SessionRunner.create({
        assistantMessage: (await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
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
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      let tools: Record<string, AITool>
      let runtime: RuntimeTools.Info | undefined
      try {
        runtime = await resolveTools({
          agent,
          session,
          model,
          tools: lastUser.tools,
          processor,
          bypassAgentCheck,
          messages: msgs,
        })
        if (agent.runner === "protocol") {
          runtime = await stable(sessionID, session, agent, runtime)
        }
        tools = agent.runner === "protocol" ? {} : runtime.tools

        // Inject StructuredOutput tool if JSON schema mode enabled
        if (lastUser.format?.type === "json_schema") {
          tools["StructuredOutput"] = createStructuredOutputTool({
            schema: lastUser.format.schema,
            onSuccess(output) {
              structuredOutput = output
            },
          })
        }
      } catch (error) {
        await failSetup({
          sessionID,
          assistant: processor.message,
          providerID: model.providerID,
          error,
          stage: "resolve_tools",
        })
        break
      }

      let instructions: string[] = []
      try {
        instructions = await agentInstructions(agent)
      } catch (error) {
        await failSetup({
          sessionID,
          assistant: processor.message,
          providerID: model.providerID,
          error,
          stage: "resolve_instructions",
        })
        break
      }

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of msgs) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      // Build system prompt, adding structured output instruction if needed
      const system = [
        ...(await SystemPrompt.environment(model)),
        ...(await SystemPrompt.task(sessionID)),
        ...(await InstructionPrompt.system()),
        ...instructions,
      ]
      const format = lastUser.format ?? { type: "text" }
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        permission: session.permission,
        abort,
        sessionID,
        system,
        messages: [
          ...MessageV2.toModelMessages(msgs, model),
          ...(footer
            ? [
                {
                  role: "user" as const,
                  content: footer,
                },
              ]
            : []),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        runtimeTools: runtime,
        model,
        actionResult,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })
      const parts = await MessageV2.parts(processor.message.id)
      const count = parts.filter((part) => part.type === "tool").length
      calls += count
      if (calls > (agent.maxToolCalls ?? MAX_TOOL_CALLS)) {
        await stopTools({
          sessionID,
          assistant: processor.message,
          user: lastUser,
          type: "tool.loop_limit",
          message: `Stopped after ${calls} consecutive tool calls. The configured limit is ${agent.maxToolCalls ?? MAX_TOOL_CALLS}.`,
          data: {
            limit: agent.maxToolCalls ?? MAX_TOOL_CALLS,
            count: calls,
          },
        })
        break
      }
      const results = actionResults(parts)
      for (const item of results) {
        failures = item.ok ? 0 : failures + 1
      }
      if (failures > ACTION_RESULT_FAILURES) {
        await stopTools({
          sessionID,
          assistant: processor.message,
          user: lastUser,
          type: "tool.action_result_limit",
          message: `Stopped after ${failures} consecutive failed ActionResult calls.`,
          data: {
            limit: ACTION_RESULT_FAILURES,
            count: failures,
          },
        })
        break
      }
      if (actionResult && results.some((item) => item.ok)) {
        await SessionDelegation.complete({ sessionID, messageID: processor.message.id })
        break
      }

      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        await done({
          sessionID,
          user: lastUser,
          assistant: processor.message,
          outcome: "completed",
          reason: "assistant",
        })
        break
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      if (modelFinished && !processor.message.error) {
        if (format.type === "json_schema") {
          // Model stopped without calling StructuredOutput tool
          processor.message.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(processor.message)
          await done({
            sessionID,
            user: lastUser,
            assistant: processor.message,
            outcome: "failed",
            reason: "error",
          })
          break
        }
        await done({
          sessionID,
          user: lastUser,
          assistant: processor.message,
          outcome: "completed",
          reason: "assistant",
        })
        continue
      }

      if (result === "stop") {
        const fresh = await MessageV2.get({ sessionID, messageID: lastUser.id }).catch(() => undefined)
        const current = fresh?.info.role === "user" ? fresh.info : lastUser
        if (SessionTurn.done(current)) {
          await resolve(sessionID, current.id, { info: processor.message, parts })
          continue
        }
        if (processor.message.time.completed) {
          await done({
            sessionID,
            user: current,
            assistant: processor.message,
            outcome: processor.message.error ? "error" : "completed",
            reason: processor.message.error ? "error" : "assistant",
          })
        }
        continue
      }
      if (result === "compact") {
        const overflow = !processor.message.finish
        if (shouldStopCompact({ messages: msgs, overflow })) {
          await stopCompact({ sessionID, assistant: processor.message })
          break
        }
        await SessionCompaction.create({
          sessionID,
          agent: agentName,
          model: selected,
          auto: true,
          overflow,
        })
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    const found = await response(sessionID, input.messageID)
    if (found) return found
    throw new Error("Session loop ended before this prompt produced a response.")
  }

  function turn(messages: MessageV2.WithParts[]) {
    const item = SessionTurn.next(messages)
    const legacy = item
      ? undefined
      : messages.find(
          (msg) =>
            msg.info.role === "user" &&
            !SessionTurn.done(msg.info) &&
            !SessionTurn.get(msg.info) &&
            !SessionTurn.fallback({ messages, user: msg.info }),
        )
    const picked = item ?? legacy
    if (!picked || picked.info.role !== "user") return
    const index = messages.findIndex((msg) => msg.info.id === picked.info.id)
    const tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
    for (let j = index + 1; j < messages.length; j++) {
      const next = messages[j]
      if (!next || next.info.role === "user") break
      tasks.push(...next.parts.filter((part) => part.type === "compaction" || part.type === "subtask"))
    }
    return {
      info: picked.info,
      tasks,
    }
  }

  async function repair(session: Session.Info) {
    const ctx = object(session.dsl_context)
    const res = object(ctx.result)
    if (res.type !== "session.action_result") {
      await turns(session.id)
      return
    }
    const item = object(object(ctx.protocol).delegation)
    if (item.type !== "agent.delegation.assignment") {
      await turns(session.id)
      return
    }
    const status = item.status
    if (
      status !== "completed" &&
      status !== "partial" &&
      status !== "blocked" &&
      status !== "failed" &&
      status !== "terminal_reply"
    ) {
      await turns(session.id)
      return
    }
    const close = async (user: MessageV2.User, msg?: MessageV2.WithParts) =>
      SessionTurn.finish({
        assistantID: msg?.info.id,
        outcome: status === "failed" ? "failed" : status === "blocked" ? "blocked" : "completed",
        reason: "action_result",
        stats: msg ? SessionTurn.stats({ message: msg }) : undefined,
        user,
      })
    if (typeof item.completed_message_id === "string") {
      const msg = await MessageV2.get({
        sessionID: session.id,
        messageID: MessageID.make(item.completed_message_id),
      }).catch(() => undefined)
      if (msg?.info.role === "assistant") {
        const user = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.parentID,
        }).catch(() => undefined)
        if (user?.info.role === "user" && !SessionTurn.done(user.info)) await close(user.info, msg)
        await turns(session.id)
        return
      }
    }
    const at = typeof item.completed_at === "number" ? item.completed_at : Date.now()
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(session.id))
    await Promise.all(
      msgs.map(async (msg) => {
        if (msg.info.role !== "user") return
        if (msg.info.time.created > at) return
        if (SessionTurn.done(msg.info)) return
        await close(msg.info)
      }),
    )
    await turns(session.id)
  }

  async function turns(sessionID: SessionID) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    await Promise.all(
      msgs.map(async (msg, index) => {
        if (msg.info.role !== "user") return
        if (SessionTurn.done(msg.info)) return
        const wait = delegated(msgs, msg.info, index)
        if (wait) {
          const turn = SessionTurn.get(msg.info)
          await SessionTurn.finish({
            assistantID: wait.info.id,
            outcome: "waiting_child",
            reason: "waiting_child",
            runID: wait.runID,
            stats: {
              ...turn?.stats,
              ...SessionTurn.stats({ message: wait }),
            },
            user: msg.info,
          })
          return
        }
        const assistant = closed(msgs, msg.info.id, index) ?? (await aborted(msgs, msg.info.id, index))
        if (!assistant) return
        await SessionTurn.finish({
          assistantID: assistant.info.id,
          outcome: assistant.info.error ? "error" : "completed",
          reason: assistant.info.error ? "error" : "assistant",
          stats: SessionTurn.stats({ message: assistant }),
          user: msg.info,
        })
      }),
    )
  }

  function delegated(msgs: MessageV2.WithParts[], user: MessageV2.User, index: number) {
    const turn = SessionTurn.get(user)
    if (!turn || turn.status !== "running") return
    if (!Array.isArray(turn.children) || turn.children.length === 0) return
    if (!turn.children.every((child) => typeof child.notified_at === "number" || typeof child.result_id === "string")) return
    if (!msgs.slice(index + 1).some((item) => item.info.role === "user")) return
    for (let i = index + 1; i < msgs.length; i++) {
      const msg = msgs[i]
      if (!msg) continue
      if (msg.info.role === "user") return
      if (msg.info.role !== "assistant") continue
      if (msg.info.parentID !== user.id) continue
      if (typeof msg.info.time.completed !== "number") continue
      if (msg.info.finish !== "tool-calls") continue
      return {
        ...msg,
        runID: turn.run_id ?? turn.children.find((child) => typeof child.run === "string")?.run,
      }
    }
    return
  }

  async function aborted(msgs: MessageV2.WithParts[], parent: MessageID, index: number) {
    for (let i = index + 1; i < msgs.length; i++) {
      const msg = msgs[i]
      if (!msg) continue
      if (msg.info.role === "user") return
      if (msg.info.role !== "assistant") continue
      if (msg.info.parentID !== parent) continue
      if (msg.info.time.completed) return
      if (msg.info.finish) return
      if (!msgs.slice(i + 1).some((item) => item.info.role === "user")) return
      const empty = msg.parts.every((part) => part.type === "step-start" || part.type === "reasoning")
      if (!empty) return
      msg.info.error = new MessageV2.AbortedError({ message: "Session was aborted before the assistant completed." }).toObject()
      msg.info.finish = "error"
      msg.info.time.completed = Date.now()
      await Session.updateMessage(msg.info)
      return { info: msg.info, parts: msg.parts }
    }
    return
  }

  function closed(msgs: MessageV2.WithParts[], parent: MessageID, index: number) {
    for (let i = index + 1; i < msgs.length; i++) {
      const msg = msgs[i]
      if (!msg) continue
      if (msg.info.role === "user") return
      if (msg.info.role !== "assistant") continue
      if (msg.info.parentID !== parent) continue
      if (typeof msg.info.time.completed !== "number") continue
      if (!msg.info.error && (!msg.info.finish || msg.info.finish === "tool-calls" || msg.info.finish === "unknown"))
        continue
      return msg.info.role === "assistant" ? { info: msg.info, parts: msg.parts } : undefined
    }
    return
  }

  async function done(input: {
    assistant: MessageV2.Assistant
    outcome: SessionTurn.Outcome
    reason: SessionTurn.Reason
    sessionID: SessionID
    user: MessageV2.User
  }) {
    const parts = await MessageV2.parts(input.assistant.id)
    const user = await SessionTurn.finish({
      assistantID: input.assistant.id,
      outcome: input.outcome,
      reason: input.reason,
      stats: SessionTurn.stats({ message: { info: input.assistant, parts } }),
      user: input.user,
    })
    await resolve(input.sessionID, user.id, { info: input.assistant, parts })
  }

  async function resolve(sessionID: SessionID, messageID: MessageID, msg: MessageV2.WithParts) {
    const entry = state()[sessionID]
    if (!entry) return
    const keep = entry.callbacks.filter((item) => {
      if (item.messageID && item.messageID !== messageID) return true
      item.resolve(msg)
      return false
    })
    entry.callbacks = keep
  }

  async function response(sessionID: SessionID, messageID?: MessageID) {
    const messages = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg || msg.info.role !== "assistant") continue
      if (messageID && msg.info.parentID !== messageID) continue
      return msg
    }
    return
  }

  export function shouldStopCompact(input: { messages: MessageV2.WithParts[]; overflow: boolean }) {
    if (!input.overflow) return false
    const count = input.messages
      .flatMap((item) => item.parts)
      .filter((part) => part.type === "compaction" && part.auto && part.overflow === true).length
    return count >= MAX_AUTO_OVERFLOW_COMPACTIONS
  }

  async function resumeAfter(sessionID: SessionID, after: MessageID | undefined) {
    const entry = state()[sessionID]
    if (!entry) return

    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID)).catch(() => [])
    const user = SessionTurn.next(msgs)

    if (!user) {
      const callbacks = entry.callbacks
      callbacks.forEach((item) => item.reject(new Error("Session loop ended before pending user was processed.")))
      delete state()[sessionID]
      return
    }

    await loop({ sessionID, resume_existing: true })
  }

  async function next(sessionID: SessionID) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID)).catch(() => [])
    return SessionTurn.next(msgs)
  }

  async function stopCompact(input: { sessionID: SessionID; assistant: MessageV2.Assistant }) {
    const text = [
      "Automatic compaction was attempted multiple times, but the request is still too large for the provider.",
      "",
      "Start a new session for this task, or remove/truncate older messages, large tool outputs, and attachments before retrying.",
    ].join("\n")
    input.assistant.error = new MessageV2.ContextOverflowError({ message: text }).toObject()
    input.assistant.finish = "error"
    input.assistant.time.completed = Date.now()
    await Session.updateMessage(input.assistant)
    SessionStatus.set(input.sessionID, { type: "error", message: text })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.assistant.id,
      level: "error",
      type: "llm.compact_limit",
      data: { limit: MAX_AUTO_OVERFLOW_COMPACTIONS, error: text },
    })
  }

  function actionResults(parts: MessageV2.Part[]) {
    return parts
      .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === ActionResult.TOOL)
      .map((part) => {
        if (part.state.status === "completed") return { ok: true, part }
        if (part.state.status !== "error") return { ok: false, part, error: part.state.status }
        return { ok: false, part, error: part.state.error }
      })
  }

  function context(session: Session.Info, agent: Agent.Info): LLM.StreamInput["actionResult"] | undefined {
    const delegation = object(object(session.dsl_context).protocol).delegation
    const item = object(delegation)
    if (item.result_tool !== ActionResult.TOOL) return
    const action = str(item.action_id)
    const target = agent.kind === "verifier" ? targetAction(item) : undefined
    return {
      action,
      target,
      verifier: agent.kind === "verifier",
    }
  }

  function requestFooter(input: {
    session: Session.Info
    agent: Agent.Info
    actionResult?: LLM.StreamInput["actionResult"]
  }) {
    const prompt = input.agent.requestFooter?.prompt
    if (!prompt) return
    const delegation = object(object(input.session.dsl_context).protocol).delegation
    const vars = RequestFooter.variables({
      sessionID: input.session.id,
      agent: input.agent.name,
      mode: input.agent.mode,
      delegation: object(delegation),
      actionResult: input.actionResult,
    })
    const text = RequestFooter.render(prompt, vars)
    void SessionLog.emit({
      sessionID: input.session.id,
      level: "debug",
      type: "request.footer.applied",
      data: {
        agent: input.agent.name,
        file: input.agent.requestFooter?.file,
        chars: text.length,
        vars: Object.entries(vars).flatMap(([key, value]) => (value ? [key] : [])),
        action_id: input.actionResult?.action,
        target_action_id: input.actionResult?.target,
      },
    }).catch((err) => log.warn("request footer log failed", { err }))
    return text
  }

  function targetAction(input: Record<string, unknown>) {
    const meta = object(input.metadata)
    const verification = object(meta.verification)
    const worker = str(verification.worker)
    if (worker) return worker
    const deps = input.depends_on
    const dep = Array.isArray(deps) ? deps.map(str).find((item): item is string => Boolean(item)) : undefined
    if (dep) return dep
    return infer(str(input.action_id))
  }

  function str(input: unknown) {
    return typeof input === "string" && input.trim() ? input.trim() : undefined
  }

  function infer(input: string | undefined) {
    if (!input) return
    for (const suffix of ["_test", "_review"]) {
      if (input.endsWith(suffix)) return input.slice(0, -suffix.length)
    }
  }

  async function stopTools(input: {
    sessionID: SessionID
    assistant: MessageV2.Assistant
    user: MessageV2.User
    type: string
    message: string
    data: Record<string, unknown>
  }) {
    input.assistant.error = MessageV2.fromError(new Error(input.message), { providerID: input.assistant.providerID })
    input.assistant.finish = "error"
    input.assistant.time.completed = Date.now()
    await Session.updateMessage(input.assistant)
    SessionStatus.set(input.sessionID, { type: "blocked", message: input.message })
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.assistant.id,
      level: "error",
      type: input.type,
      data: {
        ...input.data,
        error: input.message,
      },
    }).catch((err) => log.warn("session log failed", { err }))
    await done({
      sessionID: input.sessionID,
      user: input.user,
      assistant: input.assistant,
      outcome: "blocked",
      reason: "error",
    })
  }

  /** @internal Exported for testing */
  export async function failSetup(input: {
    sessionID: SessionID
    assistant: MessageV2.Assistant
    providerID: ProviderID
    error: unknown
    stage: string
  }) {
    const error = MessageV2.fromError(input.error, { providerID: input.providerID })
    const message = "message" in error.data ? String(error.data.message) : error.name
    log.error("setup failed", { stage: input.stage, error: input.error })
    input.assistant.error = error
    input.assistant.finish = "error"
    input.assistant.time.completed = Date.now()
    await Session.updateMessage(input.assistant)
    await SessionLog.emit({
      sessionID: input.sessionID,
      messageID: input.assistant.id,
      level: "error",
      type: "llm.error",
      data: {
        stage: input.stage,
        error: message,
        name: error.name,
      },
    }).catch((err) => log.warn("session log failed", { err }))
    Bus.publish(Session.Event.Error, {
      sessionID: input.sessionID,
      error,
    })
    SessionStatus.set(input.sessionID, { type: "error", message })
  }

  async function lastModel(sessionID: SessionID) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  function equal(
    left: { providerID: ProviderID; modelID: ModelID } | undefined,
    right: { providerID: ProviderID; modelID: ModelID },
  ) {
    return left?.providerID === right.providerID && left.modelID === right.modelID
  }

  function pref(session: Session.Info) {
    return {
      agent: session.agent,
      model: session.model,
    }
  }

  function bound(session: Session.Info, agent: string | undefined) {
    if (!session.agent || !agent || session.agent === agent) return
    throw new ConflictError({
      message: `Session ${session.id} has bound agent "${session.agent}". Update the session agent before sending with "${agent}".`,
    })
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }): Promise<RuntimeTools.Info> {
    using _ = log.time("resolveTools")
    return RuntimeTools.build(input)
  }

  async function agentInstructions(agent: Agent.Info) {
    const registry = getRegistry()
    const template = await registry.get(agent.name)
    if (!template?.meta.instructions?.files?.length) return []

    const status = (await registry.templates()).find((item) => item.valid && item.id === template.id)
    if (!status) return []

    const result = await resolveInstructions({
      meta: template.meta,
      agentDir: status.dir,
      projectRoot: Instance.worktree,
      workspaceRoot: Instance.directory,
      globalRulesPath: path.join(Global.Path.config, "AGENTS.md"),
      userHome: Global.Path.home,
      runDir: Instance.directory,
    })
    if (result.blocking) {
      throw new Error(
        [
          `Agent instruction resolution failed for ${template.id}`,
          ...result.diagnostics
            .filter((item) => item.blocking)
            .map((item) => `${item.code}: ${item.message}`),
        ].join("\n"),
      )
    }

    return result.records
      .filter((item) => item.content !== undefined)
      .map((item) =>
        [
          "<agent-instruction>",
          `Source: ${item.path}`,
          item.resolved ? `Resolved path: ${item.resolved}` : undefined,
          item.role ? `Role: ${item.role}` : undefined,
          "",
          item.content?.trimEnd(),
          "</agent-instruction>",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      )
  }

  type RuntimeContext = {
    protocol?: {
      agent?: string
      prompt?: string
      catalog?: string[]
      signature?: string
    }
  }

  function obj(input: unknown) {
    return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
  }

  async function cache(sessionID: SessionID) {
    return Storage.read<RuntimeContext>(["session_runtime_context", sessionID]).catch(() => undefined)
  }

  async function stable(
    sessionID: SessionID,
    session: Session.Info,
    agent: Agent.Info,
    runtime: RuntimeTools.Info,
  ): Promise<RuntimeTools.Info> {
    const ids = runtime.catalog.map((item) => item.id)
    const signature = JSON.stringify({
      agent: agent.name,
      catalog: runtime.catalog.map((item) => ({
        id: item.id,
        description: item.description,
        schema: item.schema,
      })),
    })
    const saved = await cache(sessionID)
    if (
      saved?.protocol?.prompt &&
      saved.protocol.agent === agent.name &&
      saved.protocol.signature === signature
    ) {
      return { ...runtime, prompt: saved.protocol.prompt }
    }

    const ctx = session.dsl_context && typeof session.dsl_context === "object" && !Array.isArray(session.dsl_context) ? session.dsl_context : {}
    const prev = obj(ctx.protocol)
    const tools = obj(prev.tools)
    const legacy = Array.isArray(tools.catalog) ? tools.catalog.filter((item) => typeof item === "string") : []
    const prompt = typeof tools.prompt === "string" && same(legacy, ids) ? tools.prompt : runtime.prompt
    await Storage.write(["session_runtime_context", sessionID], {
      protocol: {
        agent: agent.name,
        prompt,
        catalog: ids,
        signature,
      },
    } satisfies RuntimeContext)
    if (typeof tools.prompt === "string" || prev.tools !== undefined) {
      await Session.setDslContext({
        sessionID,
        dsl_context: {
          ...ctx,
          protocol: Object.fromEntries(Object.entries(prev).filter((item) => item[0] !== "tools")),
        },
      })
    }
    return { ...runtime, prompt }
  }

  function same(left: string[], right: string[]) {
    return left.length === right.length && left.every((item, index) => item === right[index])
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  async function createUserMessage(input: PromptInput, session: Session.Info) {
    const sessionPref = pref(session)
    bound(session, input.agent)
    const agentName = sessionPref.agent ?? input.agent ?? (await Agent.defaultAgent())
    const agent = agentName ? await Agent.get(agentName) : undefined

    const model = input.model ?? sessionPref.model ?? agent?.model ?? (await lastModel(input.sessionID))
    const full =
      !input.variant && agent?.variant
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant = input.variant ?? (agent?.variant && full?.variants?.[agent?.variant] ? agent?.variant : undefined)

    const now = Date.now()
    const info: MessageV2.User = {
      id: input.messageID ?? MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: now,
      },
      tools: input.tools,
      agent: agent?.name ?? agentName ?? "unknown",
      model,
      system: input.system,
      format: input.format,
      variant,
      metadata:
        input.noReply === true && input.metadata?.turn === undefined
          ? input.metadata
          : {
              ...input.metadata,
              turn: input.metadata?.turn ?? {
                kind: input.metadata?.internal === true ? "internal" : "user",
                status: "queued",
                time: { queued: now },
              },
            },
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ? PartID.make(part.id) : PartID.ascending(),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (
          part.type === "text" &&
          input.metadata?.internal !== true &&
          (part.metadata?.kind === "task_update_proposal" || part.metadata?.kind === "task_update_progress")
        ) {
          const metadata = { ...part.metadata }
          for (const key of [
            "kind",
            "proposal_id",
            "assignment_id",
            "draft_revision_id",
            "old_revision_id",
            "difference_summary",
            "affected_child_ids",
            "reusable_result_refs",
            "status",
            "error",
          ])
            delete metadata[key]
          return [{ ...part, metadata, messageID: info.id, sessionID: input.sessionID }]
        }
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              await FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent?.permission ?? [])
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Session.insert({ info, parts })

    return {
      info,
      parts,
    }
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // Original logic when experimental plan mode is disabled
    if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
        })
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name !== "plan") {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
        })
      }
      return input.messages
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to execution mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (exists) {
        const part = await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    confirm: z.boolean().optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }

    using _ = defer(() => void resumeShell(input.sessionID))

    const session = await Session.get(input.sessionID)
    bound(session, input.agent)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    if (!agent) throw new Error(`Agent not found: ${input.agent}`)
    const sessionPref = pref(session)
    const model = input.model ?? sessionPref.model ?? agent.model ?? (await lastModel(input.sessionID))
    if (input.model && !equal(session.model, input.model)) {
      await Session.setModel({ sessionID: input.sessionID, model: input.model, confirm: input.confirm })
    }
    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
      ignored: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      ignored: true,
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  async function resumeShell(sessionID: SessionID) {
    const queued = await next(sessionID)
    if (!queued) {
      cancel(sessionID)
      return
    }
    await loop({ sessionID, resume_existing: true }).catch((error) => {
      log.error("session loop failed to resume after shell command", { sessionID, error })
    })
  }

  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    confirm: z.boolean().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)
    const command = await Command.get(input.command)
    const session = await Session.get(input.sessionID)
    bound(session, input.agent)
    const sessionPref = pref(session)
    const agentName = sessionPref.agent ?? command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return sessionPref.model ?? (await lastModel(input.sessionID))
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = agentName ? await Agent.get(agentName) : undefined
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => AgentEntry.primary(a)).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName ?? "undefined"}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = command.subtask === true || (command.subtask !== false && AgentEntry.subtask(agent))
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : sessionPref.model ?? (await lastModel(input.sessionID))
      : taskModel

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      confirm: input.confirm,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: ProviderID
    modelID: ModelID
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    try {
      const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
      if (text) {
        const cleaned = text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!cleaned) return

        const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
        const session = await Session.get(input.session.id)
        if (!Session.isDefaultTitle(session.title)) return
        return Session.setTitle({ sessionID: input.session.id, title })
      }
    } finally {
      result.release?.()
    }
  }
}
