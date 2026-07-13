import { MessageV2 } from "./message-v2"
import { Session } from "."
import { MessageID } from "./schema"

export namespace SessionTurn {
  export type Kind = "user" | "internal"
  export type Status = "queued" | "running" | "done"
  export type Outcome = "completed" | "waiting_user" | "waiting_child" | "failed" | "blocked" | "error"
  export type Reason =
    | "assistant"
    | "protocol"
    | "action_result"
    | "waiting_user"
    | "waiting_child"
    | "malformed"
    | "error"
  export type Stats = {
    tools?: number
    children?: number
    actions?: number
    confirmations?: number
    duration_ms?: number
  }
  export type Child = {
    id: string
    label: string
    run?: string
    action?: string
    status?: string
    current?: boolean
    result_id?: string
    summary?: string
    fallback?: boolean
    created_at?: number
    completed_at?: number
    notified_at?: number
  }
  export type Info = {
    kind: Kind
    status: Status
    outcome?: Outcome
    reason?: Reason
    assistant_id?: MessageID
    run_id?: string
    stats?: Stats
    children?: Child[]
    time: {
      queued: number
      started?: number
      completed?: number
    }
  }

  export function get(input: MessageV2.Info | undefined) {
    if (!input || input.role !== "user") return
    const value = input.metadata?.turn
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    return value as Info
  }

  export function done(input: MessageV2.Info | undefined) {
    return get(input)?.status === "done"
  }

  export async function queue(input: { user: MessageV2.User; kind?: Kind }) {
    const turn = get(input.user)
    if (turn) return input.user
    return write(input.user, {
      kind: input.kind ?? kind(input.user),
      status: "queued",
      time: { queued: input.user.time.created },
    })
  }

  export async function run(input: { user: MessageV2.User }) {
    const turn = get(input.user)
    if (turn?.status === "running") return input.user
    if (turn?.status === "done") return input.user
    return write(input.user, {
      ...(turn ?? { kind: kind(input.user), time: { queued: input.user.time.created } }),
      status: "running",
      time: {
        ...(turn?.time ?? { queued: input.user.time.created }),
        started: turn?.time.started ?? Date.now(),
      },
    })
  }

  export async function finish(input: {
    assistantID?: MessageID
    outcome: Outcome
    reason: Reason
    runID?: string
    stats?: Stats
    user: MessageV2.User
  }) {
    const turn = get(input.user)
    if (turn?.status === "done") return input.user
    return write(input.user, {
      ...(turn ?? { kind: kind(input.user), time: { queued: input.user.time.created } }),
      status: "done",
      outcome: input.outcome,
      reason: input.reason,
      assistant_id: input.assistantID,
      run_id: input.runID,
      stats: input.stats,
      time: {
        ...(turn?.time ?? { queued: input.user.time.created }),
        started: turn?.time.started ?? input.user.time.created,
        completed: Date.now(),
      },
    })
  }

  export function fallback(input: { messages: MessageV2.WithParts[]; user: MessageV2.User }) {
    if (get(input.user)) return false
    const idx = input.messages.findIndex((item) => item.info.id === input.user.id)
    if (idx === -1) return false
    for (let i = idx + 1; i < input.messages.length; i++) {
      const item = input.messages[i]
      if (!item) continue
      if (item.info.role === "user") return false
      if (item.info.role !== "assistant") continue
      if (item.info.parentID !== input.user.id) continue
      if (typeof item.info.time.completed === "number") return true
    }
    return false
  }

  export function stats(input: { message: MessageV2.WithParts; parts?: MessageV2.Part[] }) {
    const parts = input.parts ?? input.message.parts
    const tools = parts.filter((part) => part.type === "tool").length
    const actions = parts.filter((part) => {
      if (part.type !== "text") return false
      const protocol = part.metadata?.protocol
      return protocol && typeof protocol === "object"
    }).length
    return { tools, actions }
  }

  function kind(input: MessageV2.User): Kind {
    return input.metadata?.internal === true ? "internal" : "user"
  }

  async function write(user: MessageV2.User, turn: Info) {
    const msg = await Session.updateMessage({
      ...user,
      metadata: {
        ...user.metadata,
        turn,
      },
    })
    return msg as MessageV2.User
  }
}
