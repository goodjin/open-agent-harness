import type { SessionRunsResponse } from "@open-agent-harness/sdk/v2/client"

type Action = SessionRunsResponse[number]["actions"][number]
type Doc = NonNullable<SessionRunsResponse[number]["documents"]>[number]

export const progress = (actions: Action[]) => ({
  done: actions.filter((action) => action.status === "completed").length,
  total: actions.length,
})

export const groups = (documents: Doc[]) =>
  (["requirements", "designs", "plans", "reviews", "manifest"] as const).flatMap((type) => {
    const items = documents.filter((doc) => doc.type === type)
    return items.length ? [{ type, documents: items }] : []
  })

export const task = (action: Action) => {
  const value = action.input?.prompt ?? action.input?.task ?? action.input?.request
  if (typeof value === "string" && value.trim()) return value
  if (!action.input || Object.keys(action.input).length === 0) return undefined
  return JSON.stringify(action.input, null, 2)
}
