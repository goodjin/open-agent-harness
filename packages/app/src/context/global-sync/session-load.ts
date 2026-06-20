import type { Session, SessionStatus, SessionTreeNode } from "@open-agent-harness/sdk/v2/client"
import type { RootLoadArgs, TreeLoadArgs } from "./types"

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  const pick = (sessions: Session[] | undefined) =>
    input.keepRoot ? (sessions ?? []).filter(input.keepRoot) : sessions
  if (input.all) {
    const result = await input.list({ directory: input.directory, roots: true })
    const data = pick(result.data)
    return {
      data,
      limit: input.limit,
      limited: false,
      ids: (data ?? []).map((session) => session.id),
    } as const
  }
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    const data = pick(result.data)
    return {
      data,
      limit: input.limit,
      limited: true,
      ids: (data ?? []).map((session) => session.id),
    } as const
  } catch {
    const result = await input.list({ directory: input.directory, roots: true })
    const data = pick(result.data)
    return {
      data,
      limit: input.limit,
      limited: false,
      ids: (data ?? []).map((session) => session.id),
    } as const
  }
}

export async function loadSessionTreeWithFallback(input: TreeLoadArgs) {
  const roots = await loadRootSessionsWithFallback(input)
  const ids = roots.ids.filter((id) => !input.loaded?.has(id))
  const found = input.children ? await loadChildren(input, roots.data ?? [], ids) : undefined
  const by = new Map((roots.data ?? []).map((session) => [session.id, session]))
  for (const session of found?.data ?? []) {
    by.set(session.id, session)
  }
  return {
    ...roots,
    data: [...by.values()],
    status: found?.status ?? {},
  }
}

async function loadChildren(input: TreeLoadArgs, roots: Session[], ids: string[]) {
  if (ids.length === 0) return undefined
  if (input.tree) {
    const trees = await Promise.all(ids.map((root) => input.tree!({ directory: input.directory, root })))
    const rootsByID = new Map(roots.map((session) => [session.id, session]))
    const nodes = trees.flatMap((tree) => tree.data?.nodes ?? [])
    return {
      data: nodes
        .filter((node) => !!node.parent_id)
        .map((node) => sessionFromNode(node, rootsByID.get(node.root_id))),
      status: Object.fromEntries(nodes.map((node) => [node.id, node.status])) as Record<string, SessionStatus>,
    }
  }
  if (!input.descendants) return undefined
  const result = await input.descendants({ directory: input.directory, ids })
  return {
    data: result.data,
    status: {},
  }
}

export function mergeSessionStatus(
  current: Record<string, SessionStatus>,
  next: Record<string, SessionStatus>,
) {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(next).filter((item) =>
        item[1].type === "idle" || item[1].type === "archived" ? current[item[0]] === undefined : true,
      ),
    ),
  }
}

export function sessionFromNode(node: SessionTreeNode, root?: Session): Session {
  return {
    id: node.id,
    slug: node.id,
    projectID: root?.projectID ?? "",
    workspaceID: root?.workspaceID,
    directory: root?.directory ?? "",
    parentID: node.parent_id,
    title: node.title,
    agent: node.agent,
    model: node.model
      ? {
          providerID: node.model.provider_id,
          modelID: node.model.model_id,
        }
      : undefined,
    version: root?.version ?? "v2",
    summary: {
      additions: node.stats.additions,
      deletions: node.stats.deletions,
      files: node.stats.files,
    },
    time: {
      created: node.time.created,
      updated: node.time.updated,
    },
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
