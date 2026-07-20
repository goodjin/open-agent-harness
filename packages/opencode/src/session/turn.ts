import { MessageV2 } from "./message-v2"
import { Session } from "."
import { MessageID } from "./schema"
import { Bus } from "@/bus"
import { and, Database, eq } from "@/storage/db"
import { MessageTable } from "./session.sql"

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
    agent?: string
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

  export function next(messages: MessageV2.WithParts[]) {
    return messages
      .filter((item) => item.info.role === "user" && get(item.info)?.status === "queued")
      .sort((a, b) => {
        if (a.info.role !== "user" || b.info.role !== "user") return 0
        const first = get(a.info)?.time.queued ?? a.info.time.created
        const second = get(b.info)?.time.queued ?? b.info.time.created
        if (first !== second) return first - second
        return a.info.id.localeCompare(b.info.id)
      })[0]
  }

  export function active(messages: MessageV2.WithParts[]) {
    return messages
      .filter((item) => item.info.role === "user" && get(item.info)?.status === "running")
      .sort((a, b) => {
        if (a.info.role !== "user" || b.info.role !== "user") return 0
        const first = get(a.info)?.time.started ?? a.info.time.created
        const second = get(b.info)?.time.started ?? b.info.time.created
        if (first !== second) return first - second
        return a.info.id.localeCompare(b.info.id)
      })[0]
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
    const next = {
      ...(turn ?? { kind: kind(input.user), time: { queued: input.user.time.created } }),
      status: "running",
      time: {
        ...(turn?.time ?? { queued: input.user.time.created }),
        started: turn?.time.started ?? Date.now(),
      },
    } satisfies Info
    if (turn?.status === "queued") {
      return Session.claim({
        ...input.user,
        metadata: {
          ...input.user.metadata,
          turn: next,
        },
      })
    }
    return write(input.user, next)
  }

  export async function finish(input: {
    assistantID?: MessageID
    outcome: Outcome
    reason: Reason
    runID?: string
    stats?: Stats
    user: MessageV2.User
  }) {
    return Database.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(MessageTable)
          .where(and(eq(MessageTable.id, input.user.id), eq(MessageTable.session_id, input.user.sessionID)))
          .get()
        const user = row ? ({ ...row.data, id: row.id, sessionID: row.session_id } as MessageV2.User) : input.user
        const turn = get(user)
        if (turn?.status === "done" && priority(turn.outcome) >= priority(input.outcome)) return user
        const next = {
          ...(turn ?? { kind: kind(user), time: { queued: user.time.created } }),
          status: "done",
          outcome: input.outcome,
          reason: input.reason,
          assistant_id: input.assistantID,
          run_id: input.runID,
          stats: { ...turn?.stats, ...input.stats },
          time: {
            ...(turn?.time ?? { queued: user.time.created }),
            started: turn?.time.started ?? user.time.created,
            completed: Date.now(),
          },
        } satisfies Info
        const saved = { ...user, metadata: { ...user.metadata, turn: next } }
        const { id, sessionID, ...data } = saved
        tx.update(MessageTable)
          .set({ data })
          .where(and(eq(MessageTable.id, id), eq(MessageTable.session_id, sessionID)))
          .run()
        Database.effect(() => Bus.publish(MessageV2.Event.Updated, { info: saved }))
        return saved
      },
      { behavior: "immediate" },
    )
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

  function priority(input: Outcome | undefined) {
    if (input === "completed" || input === "failed" || input === "blocked" || input === "error") return 1
    return 0
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
