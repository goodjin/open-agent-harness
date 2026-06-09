import type { Session, SessionTreeNode } from "@open-agent-harness/sdk/v2/client"
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
  }
}

async function loadChildren(input: TreeLoadArgs, roots: Session[], ids: string[]) {
  if (ids.length === 0) return undefined
  if (input.tree) {
    const trees = await Promise.all(ids.map((root) => input.tree!({ directory: input.directory, root })))
    const rootsByID = new Map(roots.map((session) => [session.id, session]))
    return {
      data: trees.flatMap((tree) =>
        (tree.data?.nodes ?? [])
          .filter((node) => !!node.parent_id)
          .map((node) => sessionFromNode(node, rootsByID.get(node.root_id))),
      ),
    }
  }
  if (!input.descendants) return undefined
  return input.descendants({ directory: input.directory, ids })
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
