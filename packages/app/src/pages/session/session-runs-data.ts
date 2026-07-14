import type { SessionRunsResponse } from "@open-agent-harness/sdk/v2/client"

type Action = SessionRunsResponse[number]["actions"][number]
type Doc = NonNullable<SessionRunsResponse[number]["documents"]>[number]
type Run = SessionRunsResponse[number]

export const outcome = (run: Run) => {
  if (run.status === "running") return "running" as const
  if (run.summary_source === "fallback_summary") return "fallback" as const
  if (run.summary?.trim()) return "recorded" as const
  return "missing" as const
}

export const progress = (actions: Action[]) => ({
  done: actions.filter((action) => action.status === "completed").length,
  total: actions.length,
})

const statuses = {
  running: "session.runs.status.running",
  completed: "session.runs.status.completed",
  blocked: "session.runs.status.blocked",
  failed: "session.runs.status.failed",
} as const

const results = {
  recorded: "session.runs.recorded",
  fallback: "session.runs.fallback",
  missing: "session.runs.missingResult",
} as const

export const view = (run: Run) => {
  const value = outcome(run)
  return {
    status: { value: run.status, label: statuses[run.status] },
    result: value === "running" ? undefined : { value, label: results[value] },
    meta: {
      id: run.run_id,
      started: run.time.started,
      completed: run.time.completed,
      progress: progress(run.actions),
      documents: run.documents?.length ?? 0,
    },
  }
}

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
