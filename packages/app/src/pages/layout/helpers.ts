import { getFilename } from "@open-agent-harness/util/path"
import { type Message, type Session } from "@open-agent-harness/sdk/v2/client"

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
  const by = new Map(sessions.map((session) => [session.id, session]))
  for (const session of sessions) {
    if (!session.parentID) continue
    const existing = map.get(session.parentID)
    if (existing) {
      existing.push(session.id)
      continue
    }
    map.set(session.parentID, [session.id])
  }
  for (const ids of map.values()) {
    ids.sort((a, b) => {
      const left = by.get(a)
      const right = by.get(b)
      const diff = (right?.time.created ?? 0) - (left?.time.created ?? 0)
      if (diff !== 0) return diff
      return a < b ? -1 : a > b ? 1 : 0
    })
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
  first: boolean
  last: boolean
  guides: boolean[]
  childCount: number
  index?: number
}

export const visibleSessionTree = (
  roots: Session[],
  sessions: Session[],
  children: Map<string, string[]>,
  expanded: Set<string>,
  keep?: (session: Session) => boolean,
) => {
  const include = keep ?? (() => true)
  const by = new Map(sessions.map((s) => [s.id, s]))
  const kids = (session: Session) =>
    (children.get(session.id) ?? [])
      .map((id) => by.get(id))
      .filter((item): item is Session => !!item && !item.time?.archived)
  const rows: SessionTreeItem[] = []
  const root = roots.filter((session) => !session.time?.archived && include(session))
  const stack = root
    .map((session, index) => ({
      session,
      depth: 0,
      first: index === 0,
      last: index === root.length - 1,
      guides: [] as boolean[],
      index: undefined as number | undefined,
    }))
    .reverse()

  while (stack.length > 0) {
    const item = stack.pop()!
    const all = kids(item.session)
    const visible = all.map((session, index) => ({ session, index })).filter((item) => include(item.session))
    rows.push({
      session: item.session,
      depth: item.depth,
      first: item.first,
      last: item.last,
      guides: item.guides,
      childCount: visible.length,
      index: item.index,
    })
    if (!expanded.has(item.session.id)) continue
    for (let i = visible.length - 1; i >= 0; i--) {
      const child = visible[i]
      stack.push({
        session: child.session,
        depth: item.depth + 1,
        first: i === 0,
        last: i === visible.length - 1,
        guides: [...item.guides, !item.last],
        index: child.index,
      })
    }
  }
  return rows
}

export const sessionDescendants = (roots: Session[], sessions: Session[], children: Map<string, string[]>) => {
  const by = new Map(sessions.map((session) => [session.id, session]))
  const walk = (session: Session): Session[] => [
    session,
    ...(children.get(session.id) ?? [])
      .map((id) => by.get(id))
      .filter((item): item is Session => !!item && !item.time?.archived)
      .flatMap(walk),
  ]
  return roots.flatMap(walk)
}

export const childSummaryBySession = (
  sessions: Session[],
  children: Map<string, string[]>,
  messages: Record<string, Message[] | undefined>,
  status: Record<string, Status | undefined>,
) => {
  const by = new Map(sessions.map((session) => [session.id, session]))
  const memo = new Map<string, { completed: number; total: number; working: number }>()
  const visit = (id: string): { completed: number; total: number; working: number } => {
    const cached = memo.get(id)
    if (cached) return cached
    const result = (children.get(id) ?? []).reduce(
      (acc, child) => {
        const session = by.get(child)
        if (!session || session.time?.archived) return acc
        const next = visit(child)
        return {
          completed:
            acc.completed + next.completed + (sessionCompleted(session, messages[child], status[child]) ? 1 : 0),
          total: acc.total + next.total + 1,
          working: acc.working + next.working + (sessionWorking(messages[child], status[child]) ? 1 : 0),
        }
      },
      { completed: 0, total: 0, working: 0 },
    )
    memo.set(id, result)
    return result
  }
  for (const session of sessions) visit(session.id)
  return memo
}

export const effectiveSessionExpansion = (expanded: Record<string, boolean>, lineage: Set<string>) =>
  new Set([
    ...Object.entries(expanded)
      .filter((item) => item[1])
      .map((item) => item[0]),
    ...lineage,
  ])

type Status = {
  type?: string
}

export const sessionWorking = (messages: Message[] | undefined, status: Status | undefined) => {
  if (!status || status.type === "idle") return false
  if (status.type === "timeout" || status.type === "error") return false
  if (status.type !== "running") return true

  const user = (messages ?? []).findLast((message) => message.role === "user")
  const assistant = (messages ?? []).findLast((message) => message.role === "assistant")
  const done = typeof (assistant as { time?: { completed?: unknown } } | undefined)?.time?.completed === "number"
  const stale =
    done &&
    !!user &&
    typeof assistant?.time?.created === "number" &&
    typeof user.time?.created === "number" &&
    assistant.time.created > user.time.created

  return !stale
}

export const sessionCompleted = (session: Session, messages: Message[] | undefined, status: Status | undefined) => {
  if (sessionWorking(messages, status)) return false
  if (!messages) return (session.time.updated ?? session.time.created) > session.time.created
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      typeof (message as { time?: { completed?: unknown } }).time?.completed === "number",
  )
}

export const childSessionSummary = (
  children: Session[],
  messages: Record<string, Message[] | undefined>,
  status: Record<string, Status | undefined>,
) => {
  if (children.length === 0) return
  return {
    completed: children.filter((child) => sessionCompleted(child, messages[child.id], status[child.id])).length,
    total: children.length,
  }
}

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
  if (parts.context && /^#\d+\s+/.test(parts.name)) return `${parts.context} ${parts.name}${parts.suffix}`
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
