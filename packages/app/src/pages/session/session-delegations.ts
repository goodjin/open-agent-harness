import type { Message } from "@open-agent-harness/sdk/v2"

export type DelegationState = {
  total: number
  done: number
  active: { id: string; label: string }[]
  completed: { id: string; label: string }[]
}

const text = (input: unknown) => (typeof input === "string" ? input : undefined)

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const item = (input: unknown): input is { parent_message_id: string; child_session_id: string; action_title?: unknown } =>
  record(input) && typeof input.parent_message_id === "string" && typeof input.child_session_id === "string"

export const turn = (messages: Message[], root: string, target: string) => {
  const start = messages.findIndex((msg) => msg.id === root)
  if (start < 0) return root === target
  const next = messages.slice(start + 1).findIndex((msg) => msg.role === "user")
  return messages.slice(start, next < 0 ? undefined : start + 1 + next).some((msg) => msg.id === target)
}

const rows = (input: unknown, messageID: string, messages: Message[]) => {
  if (!Array.isArray(input)) return []
  const vals = input
    .filter(
      (value): value is { parent_message_id: string; child_session_id: string; action_title?: unknown } =>
        item(value) && turn(messages, messageID, value.parent_message_id),
    )
    .reduce((acc: Map<string, { id: string; label: string }>, value) => {
      if (acc.has(value.child_session_id)) return acc
      const label = text(value.action_title) || `子会话 ${String(value.child_session_id)}`
      acc.set(value.child_session_id, { id: value.child_session_id, label })
      return acc
    }, new Map<string, { id: string; label: string }>())
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
      (value): value is { parent_message_id: string; child_session_id: string; action_title?: unknown } =>
        item(value) && turn(messages, messageID, value.parent_message_id),
    )
    .map((value) => ({
      id: String(value.child_session_id),
      label: text(value.action_title) || `子会话 ${String(value.child_session_id)}`,
    }))

  const completed = rows(protocol.completed_delegations, messageID, messages)
  const ids = new Set(active.map((value) => value.id).concat(completed.map((value) => value.id)))

  return {
    total: ids.size,
    done: completed.length,
    active,
    completed,
  }
}
