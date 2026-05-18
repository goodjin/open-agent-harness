import type { RootLoadArgs, TreeLoadArgs } from "./types"

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
      ids: (result.data ?? []).map((session) => session.id),
    } as const
  } catch {
    const result = await input.list({ directory: input.directory, roots: true })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
      ids: (result.data ?? []).map((session) => session.id),
    } as const
  }
}

export async function loadSessionTreeWithFallback(input: TreeLoadArgs) {
  const roots = await loadRootSessionsWithFallback(input)
  const ids = roots.ids.filter((id) => !input.loaded?.has(id))
  const found = ids.length > 0 ? await input.descendants({ directory: input.directory, ids }) : undefined
  const by = new Map((roots.data ?? []).map((session) => [session.id, session]))
  for (const session of found?.data ?? []) {
    by.set(session.id, session)
  }
  return {
    ...roots,
    data: [...by.values()],
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
