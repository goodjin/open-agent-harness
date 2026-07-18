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
export type Request = "current" | "history" | "detail"

const actions = {
  pending: "session.task.action.pending",
  running: "session.task.action.running",
  completed: "session.task.action.completed",
  blocked: "session.task.action.blocked",
  failed: "session.task.action.failed",
  skipped: "session.task.action.skipped",
} as const

const handoffs = {
  proposed: "session.task.handoff.proposed",
  confirmed: "session.task.handoff.confirmed",
  creating: "session.task.handoff.creating",
  started: "session.task.handoff.started",
  failed: "session.task.handoff.failed",
  cancelled: "session.task.handoff.cancelled",
} as const

export const action = (status: Current["actions"][number]["status"]) => actions[status]
export const handoff = (status: Current["handoffs"][number]["status"]) => handoffs[status]

const terminal = (status: Status) => status === "completed" || status === "blocked" || status === "failed"

export const result = (task: Current | Revision) => {
  if (!task.result?.trim()) return "missing" as const
  if (task.result_source === "fallback_summary") return "fallback" as const
  if (task.result_source === "protocol" || task.result_source === "action_result") return "recorded" as const
  return "missing" as const
}

export const content = (task: Current | Revision) => (result(task) === "missing" ? undefined : task.result?.trim())

export const progress = (task: Current | Revision) => {
  if ("progress" in task) return task.progress
  const compact = task.workflow.compact ?? { completed: 0, total: 0 }
  return {
    completed:
      compact.completed +
      task.actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
    total: compact.total + task.actions.length,
  }
}

export const requests = () => {
  let generation = 0
  const kinds = ["current", "history", "detail"] as const
  const sequence = { current: 0, history: 0, detail: 0 }
  const controllers: Partial<Record<Request, AbortController>> = {}
  const cancel = (kind: Request) => {
    sequence[kind] += 1
    controllers[kind]?.abort()
    delete controllers[kind]
  }
  const reset = () => {
    generation += 1
    kinds.forEach(cancel)
  }
  const run = <T>(
    kind: Request,
    request: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
    reject?: (error: unknown) => void,
  ) => {
    cancel(kind)
    const current = generation
    const token = sequence[kind]
    const controller = new AbortController()
    controllers[kind] = controller
    const active = () =>
      generation === current &&
      sequence[kind] === token &&
      controllers[kind] === controller &&
      !controller.signal.aborted
    return Promise.resolve()
      .then(() => request(controller.signal))
      .then(
        (value) => {
          if (!active()) return false
          apply(value)
          return true
        },
        (error) => {
          if (!active()) return false
          reject?.(error)
          return true
        },
      )
  }
  return { cancel, reset, run }
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
