import { Log } from "@/util/log"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"

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
    return chat.process(stream)
  }
}
