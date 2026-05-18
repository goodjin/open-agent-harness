import { Log } from "@/util/log"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import { WorkflowExecutor } from "@/workflow/executor"
import type { WorkflowState } from "@/workflow/state"
import { Session } from "."
import { PartID, SessionID } from "./schema"
import { SessionStatus } from "./status"

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
      : await start(sessionID, text)

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
    const workflows = await WorkflowExecutor.list()
    const match = workflows.find((item) => text?.split(/\s+/).includes(item.id))
    const workflow = match ?? (workflows.length === 1 ? workflows[0] : undefined)
    if (!workflow) {
      const msg = workflows.length
        ? `Workflow runner needs a workflow id. Available workflows: ${workflows.map((item) => item.id).join(", ")}.`
        : "Workflow runner did not find any available workflows."
      SessionStatus.set(sessionID, { type: "idle" })
      return {
        runID: "workflow_unstarted",
        workflowID: "",
        workflowName: "Workflow Runner",
        status: "error",
        current: "",
        step: 0,
        total: 1,
        variables: {},
        attempts: {},
        completed: [],
        error: msg,
        time: {
          started: Date.now(),
          updated: Date.now(),
          completed: Date.now(),
        },
      } satisfies WorkflowState.Info
    }
    return WorkflowExecutor.run({
      sessionID,
      workflowID: workflow.id,
      variables: input(text),
    })
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
