import type { Session } from "@open-agent-harness/sdk/v2/client"

export function childSessions(sessions: readonly Session[], id: string | undefined) {
  if (!id) return []
  return sessions.filter((item) => item.parentID === id && !item.time?.archived)
}

export function childSessionCount(sessions: readonly Session[], id: string | undefined) {
  return childSessions(sessions, id).length
}
