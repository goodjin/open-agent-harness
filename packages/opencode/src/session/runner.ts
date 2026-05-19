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

export namespace SessionRunner {
  const log = Log.create({ service: "session.runner" })

  export type Kind = "chat" | "workflow"
  export type Info = ReturnType<typeof create>

  export function select(input: { runner?: Kind }): Kind {
    return input.runner ?? "chat"
  }

  export function dispatch<T>(input: { agent: { runner?: Kind } }, run: { chat(): T; workflow(): T }): T {
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
        })
      },
    }
  }

  async function workflow(chat: SessionProcessor.Info, stream: LLM.StreamInput): Promise<SessionProcessor.Result> {
    const text = stream.messages
      .slice()
      .reverse()
      .flatMap((msg) => (msg.role === "user" && typeof msg.content === "string" ? [msg.content] : []))[0]
      ?.trim()
    const sessionID = SessionID.make(stream.sessionID)
    const state = await WorkflowExecutor.status(sessionID)
    const next = state?.pause
      ? state.pause.type === "waiting_permission"
        ? await permission(sessionID, state, text)
        : await WorkflowExecutor.resume({
            sessionID,
            variables: input(text),
          })
      : state?.status === "active"
        ? await WorkflowExecutor.continueRun({
            sessionID,
            variables: input(text),
            agent: stream.agent.name,
            abort: stream.abort,
          })
        : state?.status === "completed" || state?.status === "error" || state?.status === "aborted"
          ? undefined
          : await start(sessionID, text)

    if (!next) return chat.process(stream).then((result) => generated(chat, stream, result))
    await output(chat, next)
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
    await output(chat, state)
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

  async function output(chat: SessionProcessor.Info, state: WorkflowState.Info) {
    const msg = chat.message
    const body = summary(state)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "text",
      text: body,
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    })
    msg.finish = state.status === "error" ? "error" : "stop"
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
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
