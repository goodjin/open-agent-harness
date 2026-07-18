import type {
  SessionTaskCurrentResponse,
  SessionTaskHistoryResponse,
  SessionTaskRevisionResponse,
  SessionTaskSummary,
} from "@open-agent-harness/sdk/v2/client"

export type Legacy = Extract<SessionTaskCurrentResponse, { type: "legacy_multi_run" }>
export type Current = Exclude<SessionTaskCurrentResponse, Legacy>
export type Response = Current | Legacy
export type History = SessionTaskHistoryResponse[number]
export type Revision = SessionTaskRevisionResponse
export type Status = Current["status"] | "unbound"
export type Result = "recorded" | "fallback" | "missing"
export type Request = "current" | "history" | "detail"
export type Summary = SessionTaskSummary
export type Badge = { sessionID: string; value?: Summary }
export type Feed = Badge & { current?: Response; loading: boolean; error?: string; ready: boolean }
export type Presentation =
  | { kind: "detail"; detail: Revision }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "unbound" }
  | { kind: "legacy"; legacy: Legacy }
  | { kind: "current"; current: Current }
type Timers = { set: (fn: () => void, timeout: number) => unknown; clear: (id: unknown) => void }

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
  if ("workflow" in task && !task.result_status) return "missing" as const
  if (task.result_source === "fallback_summary") return "fallback" as const
  if (task.result_source === "protocol" || task.result_source === "action_result") return "recorded" as const
  return "missing" as const
}

export const refresh = (
  run: () => void,
  delay = 5_000,
  timers: { set: (fn: () => void, timeout: number) => unknown; clear: (id: unknown) => void } = {
    set: (fn: () => void, timeout: number) => setInterval(fn, timeout),
    clear: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  },
) => {
  const id = timers.set(run, delay)
  return () => timers.clear(id)
}

export const watch = (
  on: (
    type: "session.status",
    fn: (event: { properties: { sessionID: string } }) => void,
  ) => () => void,
  run: (sessionID: string) => void,
) => {
  let stop: (() => void) | undefined
  return (sessionID?: string) => {
    stop?.()
    stop = undefined
    if (!sessionID) return
    const id = sessionID
    stop = on("session.status", (event) => {
      if (event.properties.sessionID !== id) return
      run(id)
    })
  }
}

export const stamp = (value: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value)

const historical = (task: Response): task is Legacy => "type" in task && task.type === "legacy_multi_run"

export const migration = (task?: Response): Legacy | undefined => (task && historical(task) ? task : undefined)

export const active = (task?: Response): Current | undefined => (task && !historical(task) ? task : undefined)

export const present = (
  feed: Pick<Feed, "current" | "loading" | "error">,
  detail?: Revision,
): Presentation => {
  if (detail) return { kind: "detail", detail }
  if (feed.error) return { kind: "error", error: feed.error }
  const legacy = migration(feed.current)
  if (legacy) return { kind: "legacy", legacy }
  const current = active(feed.current)
  if (current) return { kind: "current", current }
  if (feed.loading) return { kind: "loading" }
  return { kind: "unbound" }
}

export const compact = (task?: Response): Summary | undefined => {
  const item = active(task)
  return item
    ? {
        id: item.id,
        title: item.title,
        version: item.version,
        status: item.status,
        completed_actions: item.progress.completed,
        total_actions: item.progress.total,
      }
    : undefined
}

export const choose = (sessionID: string | undefined, local: Badge | undefined, fallback?: Summary) =>
  local && local.sessionID === sessionID ? local.value : fallback

export const code = (err: unknown) => {
  if (!err || typeof err !== "object") return
  const item = err as { status?: number; response?: { status?: number } }
  return item.status ?? item.response?.status
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

export const single = (run: (sessionID: string) => Promise<unknown>, reset: () => void) => {
  let active: { id: string; token: symbol; promise: Promise<void> } | undefined
  let pending: string | undefined
  const start = (id: string) => {
    const token = Symbol()
    const promise = Promise.resolve()
      .then(() => run(id))
      .then(() => {})
      .finally(() => {
        if (active?.token !== token) return
        active = undefined
        const next = pending
        pending = undefined
        if (next) void start(next)
      })
    active = { id, token, promise }
    return promise
  }
  const refresh = (id: string) => {
    if (!active) return start(id)
    if (active.id === id) pending = id
    return active.promise
  }
  const change = (id: string) => {
    reset()
    active = undefined
    pending = undefined
    return start(id)
  }
  const stop = () => {
    reset()
    active = undefined
    pending = undefined
  }
  return { change, refresh, stop }
}

export const observe = (input: {
  on: Parameters<typeof watch>[0]
  load: (sessionID: string, signal: AbortSignal) => Promise<Response>
  done: (value: Feed) => void
  missing: (err: unknown) => boolean
  error: (err: unknown) => string
  delay?: number
  timers?: Timers
}) => {
  const loader = requests()
  let id: string | undefined
  let feed: Feed | undefined
  const load = (sessionID: string) =>
    loader.run(
      "current",
      (signal) => input.load(sessionID, signal),
      (current) => {
        feed = { sessionID, current, value: compact(current), loading: false, ready: true }
        input.done(feed)
      },
      (err) => {
        if (input.missing(err)) {
          feed = { sessionID, current: undefined, value: undefined, loading: false, ready: true }
          input.done(feed)
          return
        }
        const prior = feed?.sessionID === sessionID ? feed : undefined
        feed = {
          sessionID,
          current: prior?.current,
          value: prior?.value,
          loading: false,
          ready: prior?.ready ?? false,
          error: input.error(err),
        }
        input.done(feed)
      },
    )
  const flight = single(load, loader.reset)
  const bind = watch(input.on, (sessionID) => void flight.refresh(sessionID))
  const poll = refresh(
    () => {
      if (id) void flight.refresh(id)
    },
    input.delay,
    input.timers,
  )
  const change = (sessionID?: string) => {
    id = sessionID
    bind(id)
    if (!id) {
      flight.stop()
      return
    }
    feed = { sessionID: id, loading: true, ready: false }
    input.done(feed)
    void flight.change(id)
  }
  const stop = () => {
    id = undefined
    poll()
    bind()
    flight.stop()
  }
  return { change, refresh: flight.refresh, stop }
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
  current: undefined as Response | undefined,
  history: { loaded: false, items: [] as History[] },
  detail: undefined as Revision | undefined,
  loading: { current: true, history: false, detail: false },
  error: {
    current: undefined as string | undefined,
    history: undefined as string | undefined,
    detail: undefined as string | undefined,
  },
})
