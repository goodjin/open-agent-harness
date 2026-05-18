import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { cmp } from "./utils"
import { SESSION_RECENT_LIMIT, SESSION_RECENT_WINDOW } from "./types"

export function sessionUpdatedAt(session: Session) {
  return session.time.updated ?? session.time.created
}

export function compareSessionRecent(a: Session, b: Session) {
  const aUpdated = sessionUpdatedAt(a)
  const bUpdated = sessionUpdatedAt(b)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  return cmp(a.id, b.id)
}

export function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
  if (limit <= 0) return [] as Session[]
  const selected: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!session?.id) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)
    if (sessionUpdatedAt(session) <= cutoff) continue
    const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
    if (index === -1) selected.push(session)
    if (index !== -1) selected.splice(index, 0, session)
    if (selected.length > limit) selected.pop()
  }
  return selected
}

export function trimSessions(
  input: Session[],
  options: { limit: number; permission: Record<string, PermissionRequest[]>; now?: number },
) {
  const limit = Math.max(0, options.limit)
  const cutoff = (options.now ?? Date.now()) - SESSION_RECENT_WINDOW
  const all = input
    .filter((s) => !!s?.id)
    .filter((s) => !s.time?.archived)
    .sort((a, b) => cmp(a.id, b.id))
  const roots = all.filter((s) => !s.parentID)
  const children = all.filter((s) => !!s.parentID)
  const base = roots.slice(0, limit)
  const recent = takeRecentSessions(roots.slice(limit), SESSION_RECENT_LIMIT, cutoff)
  const keepRoots = [...base, ...recent]
  const keepRootIds = new Set(keepRoots.map((s) => s.id))
  const by = children.reduce((acc, session) => {
    if (!session.parentID) return acc
    const list = acc.get(session.parentID)
    if (list) {
      list.push(session)
      return acc
    }
    acc.set(session.parentID, [session])
    return acc
  }, new Map<string, Session[]>())
  const keep = new Set(keepRootIds)
  const add = (id: string) => {
    for (const session of by.get(id) ?? []) {
      if (keep.has(session.id)) continue
      keep.add(session.id)
      add(session.id)
    }
  }
  for (const id of keepRootIds) add(id)
  for (const session of children) {
    if (session.parentID && keep.has(session.parentID)) {
      keep.add(session.id)
      add(session.id)
      continue
    }
    const perms = options.permission[session.id] ?? []
    if (perms.length === 0 && sessionUpdatedAt(session) <= cutoff) continue
    keep.add(session.id)
    add(session.id)
  }
  return all.filter((s) => keep.has(s.id)).sort((a, b) => cmp(a.id, b.id))
}
