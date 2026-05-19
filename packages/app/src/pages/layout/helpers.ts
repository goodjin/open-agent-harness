import { getFilename } from "@opencode-ai/util/path"
import { type Session } from "@opencode-ai/sdk/v2/client"

export const workspaceKey = (directory: string) => {
  const drive = directory.match(/^([A-Za-z]:)[\\/]+$/)
  if (drive) return `${drive[1]}${directory.includes("\\") ? "\\" : "/"}`
  if (/^[\\/]+$/.test(directory)) return directory.includes("\\") ? "\\" : "/"
  return directory.replace(/[\\/]+$/, "")
}

function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  workspaceKey(session.directory) === workspaceKey(directory) && !session.parentID && !session.time?.archived

export const sortedRootSessions = (store: { session: Session[]; path: { directory: string } }, now: number) =>
  store.session.filter((session) => isRootVisibleSession(session, store.path.directory)).sort(sortSessions(now))

export const latestRootSession = (stores: { session: Session[]; path: { directory: string } }[], now: number) =>
  stores
    .flatMap((store) => store.session.filter((session) => isRootVisibleSession(session, store.path.directory)))
    .sort(sortSessions(now))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined>,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request).some((list) => list?.some(include))
}

export const childMapByParent = (sessions: Session[]) => {
  const map = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const existing = map.get(session.parentID)
    if (existing) {
      existing.push(session.id)
      continue
    }
    map.set(session.parentID, [session.id])
  }
  return map
}

export const sessionLineage = (sessions: Session[], id?: string) => {
  if (!id) return new Set<string>()
  const parent = new Map(sessions.map((s) => [s.id, s.parentID]))
  const seen = new Set<string>()
  const list: string[] = []
  let next = parent.get(id)
  while (next && !seen.has(next)) {
    seen.add(next)
    list.push(next)
    next = parent.get(next)
  }
  return new Set(list)
}

export type SessionTreeItem = {
  session: Session
  depth: number
}

export const visibleSessionTree = (
  roots: Session[],
  sessions: Session[],
  children: Map<string, string[]>,
  expanded: Set<string>,
) => {
  const by = new Map(sessions.map((s) => [s.id, s]))
  const walk = (session: Session, depth: number): SessionTreeItem[] => [
    { session, depth },
    ...(expanded.has(session.id)
      ? (children.get(session.id) ?? [])
          .map((id) => by.get(id))
          .filter((item): item is Session => !!item && !item.time?.archived)
          .flatMap((item) => walk(item, depth + 1))
      : []),
  ]
  return roots.flatMap((session) => walk(session, 0))
}

export const effectiveSessionExpansion = (expanded: Record<string, boolean>, lineage: Set<string>) =>
  new Set([
    ...Object.entries(expanded)
      .filter((item) => item[1])
      .map((item) => item[0]),
    ...lineage,
  ])

const sessionTitleParts = (title: string) => {
  const trimmed = title.trim()
  const suffix = trimmed.match(/\s+\(@[^)]+\)$/)?.[0] ?? ""
  const base = suffix ? trimmed.slice(0, -suffix.length).trim() : trimmed
  const idx = base.lastIndexOf(": ")
  if (idx === -1) return { name: base, context: "", suffix }
  return {
    name: base.slice(idx + 2).trim(),
    context: base.slice(0, idx).trim(),
    suffix,
  }
}

export const displaySessionTitle = (session: Session, index?: number) => {
  if (!session.parentID) return session.title

  const parts = sessionTitleParts(session.title)
  const seq = index === undefined ? "" : `#${index + 1} `
  const name = `${seq}${parts.name}`
  if (!parts.context) return `${name}${parts.suffix}`
  return `${name} · ${parts.context}${parts.suffix}`
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree)

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = workspaceKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = workspaceKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = workspaceKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
