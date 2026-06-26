import type { Message, UserMessage } from "@open-agent-harness/sdk/v2"

export type DelegationItem = { id: string; label: string; run?: string; current?: boolean; status?: string }

export type DelegationState = {
  total: number
  done: number
  active: DelegationItem[]
  completed: DelegationItem[]
}

const text = (input: unknown) => (typeof input === "string" ? input : undefined)

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const child = (input: { child_session_id: string; action_title?: unknown; run_id?: unknown }): DelegationItem => ({
  id: input.child_session_id,
  label: text(input.action_title) || `子会话 ${String(input.child_session_id)}`,
  ...(text(input.run_id) ? { run: text(input.run_id) } : {}),
})

const turnctx = (input: UserMessage | undefined) => {
  const metadata = input?.metadata
  if (!record(metadata)) return
  const turn = metadata.turn
  if (!record(turn)) return
  return turn
}

export const timelineChildren = (input: UserMessage | undefined): DelegationItem[] => {
  const list = turnctx(input)?.children
  if (!Array.isArray(list)) return []
  return list.flatMap((value) => {
    if (!record(value) || typeof value.id !== "string") return []
    return [
      {
        id: value.id,
        label: text(value.label) ?? `子会话 ${value.id}`,
        ...(text(value.run) ? { run: text(value.run) } : {}),
        ...(typeof value.current === "boolean" ? { current: value.current } : {}),
        ...(text(value.status) ? { status: text(value.status) } : {}),
      },
    ]
  })
}

const item = (
  input: unknown,
): input is { parent_message_id: string; child_session_id: string; action_title?: unknown; run_id?: unknown } =>
  record(input) && typeof input.parent_message_id === "string" && typeof input.child_session_id === "string"

export const turn = (messages: Message[], root: string, target: string) => {
  if (root === target) return true
  const item = messages.find((msg) => msg.id === target)
  if (item?.role === "assistant" && item.parentID) return item.parentID === root
  const start = messages.findIndex((msg) => msg.id === root)
  if (start < 0) return false
  const next = messages.slice(start + 1).findIndex((msg) => msg.role === "user")
  return messages.slice(start, next < 0 ? undefined : start + 1 + next).some((msg) => msg.id === target)
}

const rows = (input: unknown, messageID: string, messages: Message[]) => {
  if (!Array.isArray(input)) return []
  const vals = input
    .filter(
      (value): value is { parent_message_id: string; child_session_id: string; action_title?: unknown; run_id?: unknown } =>
        item(value) && turn(messages, messageID, value.parent_message_id),
    )
    .reduce((acc: Map<string, DelegationItem>, value) => {
      if (acc.has(value.child_session_id)) return acc
      acc.set(value.child_session_id, child(value))
      return acc
    }, new Map<string, DelegationItem>())
  return Array.from(vals.values())
}

export const pendingDelegation = (input: unknown, messageID: string, messages: Message[]) => {
  if (!record(input)) return false
  const protocol = input.protocol
  if (!record(protocol)) return false
  const pending = protocol.pending_delegations
  if (!record(pending)) return false
  return Object.values(pending).some((value) => item(value) && turn(messages, messageID, value.parent_message_id))
}

export const delegationProgress = (input: unknown, messageID: string, messages: Message[]): DelegationState => {
  if (!record(input)) return { total: 0, done: 0, active: [], completed: [] }
  const protocol = input.protocol
  if (!record(protocol)) return { total: 0, done: 0, active: [], completed: [] }

  const active = Object.values(record(protocol.pending_delegations) ? protocol.pending_delegations : {})
    .filter(
      (value): value is { parent_message_id: string; child_session_id: string; action_title?: unknown; run_id?: unknown } =>
        item(value) && turn(messages, messageID, value.parent_message_id),
    )
    .map(child)

  const completed = rows(protocol.completed_delegations, messageID, messages)
  const ids = new Set(active.map((value) => value.id).concat(completed.map((value) => value.id)))

  return {
    total: ids.size,
    done: completed.length,
    active,
    completed,
  }
}

export const timelineProgress = (items: DelegationItem[]): DelegationState => {
  const map = items.reduce((acc: Map<string, DelegationItem>, value) => {
    if (acc.has(value.id)) return acc
    acc.set(value.id, value)
    return acc
  }, new Map<string, DelegationItem>())
  const rows = Array.from(map.values())
  const active = rows.filter((item) => item.current !== false)
  return {
    total: rows.length,
    done: rows.length - active.length,
    active,
    completed: rows.filter((item) => item.current === false),
  }
}

export const delegationSubmitted = (input: unknown, run: string | undefined) => {
  if (!run) return false
  if (!record(input)) return false
  const protocol = input.protocol
  if (!record(protocol)) return false
  const sent = protocol.delegation_notified_runs
  if (!record(sent)) return false
  return typeof sent[run] === "number"
}

export const laterUserInput = (messages: Message[], messageID: string) => {
  const index = messages.findIndex((msg) => msg.id === messageID)
  if (index < 0) return false
  return messages.slice(index + 1).some((msg) => msg.role === "user")
}
