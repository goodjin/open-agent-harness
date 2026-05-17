import type { SessionStatus } from "@opencode-ai/sdk/v2"

type Item = {
  id: string
  parentID?: string
}

export namespace HeaderStatus {
  export function resolve(input: {
    current: SessionStatus
    route?: Item
    sessions: readonly Item[]
    permission: Record<string, readonly unknown[] | undefined>
    question: Record<string, readonly unknown[] | undefined>
  }): SessionStatus {
    if (input.route?.parentID) return input.current

    const id = input.route?.id
    const visible = input.sessions.filter((item) => item.id === id || item.parentID === id)

    if (visible.some((item) => (input.permission[item.id]?.length ?? 0) > 0)) {
      return { type: "waiting_permission" }
    }

    if (visible.some((item) => (input.question[item.id]?.length ?? 0) > 0)) {
      return { type: "waiting_user" }
    }

    return input.current
  }
}
