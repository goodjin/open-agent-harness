import type {
  SessionTaskCurrentResponse,
  SessionTaskHistoryResponse,
  SessionTaskRevisionResponse,
} from "@open-agent-harness/sdk/v2/client"

export type Current = SessionTaskCurrentResponse
export type History = SessionTaskHistoryResponse[number]
export type Revision = SessionTaskRevisionResponse
export type Status = Current["status"] | "unbound"
export type Result = "recorded" | "fallback" | "missing"

const terminal = (status: Status) => status === "completed" || status === "blocked" || status === "failed"

export const result = (task: Current | Revision) => {
  if (!task.result?.trim()) return "missing" as const
  if (task.result_source === "fallback_summary") return "fallback" as const
  if (task.result_source === "protocol" || task.result_source === "action_result") return "recorded" as const
  return "missing" as const
}

export const view = (task?: Current) => {
  const status: Status = task?.status ?? "unbound"
  const showResult = terminal(status)
  return {
    status,
    showResult,
    result: showResult && task ? result(task) : undefined,
  }
}

export const initial = () => ({
  current: undefined as Current | undefined,
  history: { loaded: false, items: [] as History[] },
  detail: undefined as Revision | undefined,
  loading: { current: true, history: false, detail: false },
  error: {
    current: undefined as string | undefined,
    history: undefined as string | undefined,
    detail: undefined as string | undefined,
  },
})
