import { Button } from "@open-agent-harness/ui/button"
import { Markdown } from "@open-agent-harness/ui/markdown"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  action as actionLabel,
  compact,
  content,
  handoff as handoffLabel,
  initial,
  progress as count,
  refresh,
  requests,
  result,
  single,
  stamp,
  view,
  watch,
  type Current,
  type History,
  type Revision,
} from "./session-task-data"
import { formatServerError } from "@/utils/server-errors"

const labels = {
  unbound: "session.task.status.unbound",
  running: "session.task.status.running",
  waiting_user: "session.task.status.waitingUser",
  revising: "session.task.status.revising",
  blocked: "session.task.status.blocked",
  completed: "session.task.status.completed",
  failed: "session.task.status.failed",
} as const

const results = {
  recorded: "session.task.result.recorded",
  fallback: "session.task.result.fallback",
  missing: "session.task.result.missing",
} as const

const archives = {
  completed: "session.task.history.result.completed",
  partial: "session.task.history.result.partial",
  failed: "session.task.history.result.failed",
} as const

const tone = (status: string) => {
  if (status === "completed") return "text-icon-success-base bg-surface-success-base/20"
  if (status === "blocked" || status === "failed") return "text-icon-critical-base bg-surface-critical-weak"
  if (status === "running" || status === "active") return "text-icon-info-base bg-surface-info-base/20"
  return "text-text-weak bg-surface-raised-base"
}

const updated = (task: Current | Revision) => {
  if ("updated" in task.time) return task.time.updated
  return task.time.archived ?? task.time.created
}

const code = (err: unknown) => {
  if (!err || typeof err !== "object") return
  const item = err as { status?: number; response?: { status?: number } }
  return item.status ?? item.response?.status
}

export function SessionTask(props: { sessionID: string; onSummary?: (task: ReturnType<typeof compact>) => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore(initial())
  const [drawer, setDrawer] = createSignal(false)
  const loader = requests()

  const load = (id: string) => {
    setState("loading", "current", true)
    setState("error", "current", undefined)
    return loader.run(
      "current",
      (signal) => sdk.client.session.task.current({ sessionID: id }, { signal }),
      (res) => {
        setState({ current: res.data, loading: { ...state.loading, current: false } })
        props.onSummary?.(compact(res.data))
      },
      (err) => {
        if (code(err) === 404) {
          setState({ current: undefined, loading: { ...state.loading, current: false } })
          props.onSummary?.(undefined)
          return
        }
        setState("loading", "current", false)
        setState("error", "current", formatServerError(err, language.t, language.t("session.task.error.current")))
      },
    )
  }

  const flight = single(load, loader.reset)

  const history = () => {
    setDrawer(true)
    if (state.history.loaded || state.loading.history) return
    const id = props.sessionID
    setState("loading", "history", true)
    setState("error", "history", undefined)
    return loader.run(
      "history",
      (signal) => sdk.client.session.task.history({ sessionID: id }, { signal }),
      (res) => {
        setState("history", { loaded: true, items: res.data ?? [] })
        setState("loading", "history", false)
      },
      (err) => {
        setState("loading", "history", false)
        setState("error", "history", formatServerError(err, language.t, language.t("session.task.error.history")))
      },
    )
  }

  const revision = (version: number) => {
    const id = props.sessionID
    setState({ detail: undefined, loading: { ...state.loading, detail: true } })
    setState("error", "detail", undefined)
    return loader.run(
      "detail",
      (signal) => sdk.client.session.task.revision({ sessionID: id, version }, { signal }),
      (res) => setState({ detail: res.data, loading: { ...state.loading, detail: false } }),
      (err) => {
        setState("loading", "detail", false)
        setState("error", "detail", formatServerError(err, language.t, language.t("session.task.error.detail")))
      },
    )
  }

  const back = () => {
    loader.cancel("detail")
    setState({ detail: undefined, loading: { ...state.loading, detail: false } })
    setState("error", "detail", undefined)
    setDrawer(false)
    void flight.refresh(props.sessionID)
  }

  const bind = watch(sdk.event.on, (id) => void flight.refresh(id))

  createEffect(() => {
    const id = props.sessionID
    setDrawer(false)
    setState(initial())
    bind(id)
    void flight.change(id)
  })

  const poll = refresh(() => void flight.refresh(props.sessionID))
  onCleanup(() => {
    poll()
    bind()
    flight.stop()
  })

  const shown = () => state.detail ?? state.current
  const actions = () => shown()?.actions ?? []
  const progress = () => (shown() ? count(shown()!) : { completed: 0, total: 0 })
  const outcome = () => {
    const task = shown()
    if (!task) return "missing" as const
    return result(task)
  }
  const text = () => {
    const task = shown()
    if (!task) return
    return content(task)
  }
  return (
    <div class="flex h-full min-h-0 bg-background-stronger" data-component="session-task">
      <main class="min-w-0 flex-1 overflow-y-auto">
        <Show when={state.loading.current && !shown()}>
          <div aria-live="polite" class="mx-auto max-w-4xl px-6 py-8 text-12-regular text-text-weak">
            {language.t("session.task.loading")}
          </div>
        </Show>
        <Show when={state.error.current}>
          {(err) => (
            <div role="alert" class="mx-auto max-w-4xl px-6 py-8 text-12-regular text-icon-critical-base">
              {err()}
            </div>
          )}
        </Show>
        <Show when={!state.loading.current && !state.error.current && !shown()}>
          <div class="mx-auto max-w-4xl px-6 py-8">
            <div class="text-16-medium text-text-strong">{language.t("session.task.unbound.title")}</div>
            <div class="mt-2 text-12-regular text-text-weak">{language.t("session.task.unbound.description")}</div>
          </div>
        </Show>

        <Show when={shown()}>
          {(task) => (
            <div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-5">
              <section>
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <div class="text-11-medium uppercase text-text-weak">
                      {state.detail
                        ? language.t("session.task.archived", { version: task().version })
                        : language.t("session.task.current")}
                    </div>
                    <h2 class="mt-1 text-16-medium text-text-strong">{task().title}</h2>
                    <div class="mt-1 text-11-regular text-text-weak">
                      {language.t("session.task.meta", {
                        version: task().version,
                        time: stamp(updated(task()), language.intl()),
                      })}
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <span
                      class={`rounded px-2 py-1 text-11-medium ${tone(state.detail ? "archived" : view(state.current).status)}`}
                    >
                      {state.detail
                        ? language.t("session.task.status.archived")
                        : language.t(labels[view(state.current).status])}
                    </span>
                    <Show when={!state.detail}>
                      <Button variant="ghost" size="small" onClick={() => void history()}>
                        {language.t("session.task.history")}
                      </Button>
                    </Show>
                    <Show when={state.detail}>
                      <Button variant="ghost" size="small" onClick={back}>
                        {language.t("session.task.return")}
                      </Button>
                    </Show>
                  </div>
                </div>
              </section>

              <section class="rounded-md border border-border-weaker-base bg-background-base p-4">
                <Markdown text={task().body} />
              </section>

              <section>
                <h3 class="mb-2 text-13-medium text-text-strong">{language.t("session.task.progress")}</h3>
                <div class="rounded-md border border-border-weaker-base bg-background-base p-4">
                  <div class="text-12-regular text-text-weak">
                    {language.t("session.task.progressValue", {
                      completed: progress().completed,
                      total: progress().total,
                    })}
                  </div>
                  <Show when={actions().length > 0}>
                    <div class="mt-3 flex flex-col gap-2">
                      <For each={actions()}>
                        {(action) => (
                          <div class="flex items-start justify-between gap-3 rounded bg-background-stronger px-3 py-2">
                            <div class="min-w-0">
                              <div class="text-12-medium text-text-strong">{action.title}</div>
                              <Show when={action.summary ?? action.error}>
                                {(summary) => <div class="mt-1 text-11-regular text-text-weak">{summary()}</div>}
                              </Show>
                            </div>
                            <span class={`shrink-0 rounded px-1.5 py-0.5 text-10-medium ${tone(action.status)}`}>
                              {language.t(actionLabel(action.status))}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </section>

              <section>
                <h3 class="mb-2 text-13-medium text-text-strong">{language.t("session.task.result")}</h3>
                <div class="rounded-md border border-border-weaker-base bg-background-base p-4">
                  <Show
                    when={state.detail || view(state.current).showResult}
                    fallback={
                      <div class="text-12-regular text-text-weak">
                        {language.t("session.task.result.running", {
                          completed: progress().completed,
                          total: progress().total,
                        })}
                      </div>
                    }
                  >
                    <div class="mb-2 text-11-medium text-text-weak">{language.t(results[outcome()])}</div>
                    <Show
                      when={text()}
                      fallback={
                        <div class="text-12-regular text-text-weak">{language.t("session.task.result.missing")}</div>
                      }
                    >
                      {(text) => <Markdown text={text()} />}
                    </Show>
                  </Show>
                </div>
              </section>

              <section>
                <h3 class="mb-2 text-13-medium text-text-strong">{language.t("session.task.handoffs")}</h3>
                <Show
                  when={task().handoffs.length > 0}
                  fallback={
                    <div class="text-12-regular text-text-weak">{language.t("session.task.handoffs.empty")}</div>
                  }
                >
                  <div class="flex flex-col gap-2">
                    <For each={task().handoffs}>
                      {(item) => (
                        <div class="rounded-md border border-border-weaker-base bg-background-base p-3">
                          <div class="text-12-medium text-text-strong">{item.title}</div>
                          <div class="mt-1 text-11-regular text-text-weak">{language.t(handoffLabel(item.status))}</div>
                          <div class="mt-1 text-11-regular text-text-weak">
                            {language.t("session.task.handoff.target", { session: item.target_session_id ?? "-" })}
                            <Show when={item.target_task_id}> · {item.target_task_id}</Show>
                          </div>
                          <Show when={item.error}>
                            {(error) => (
                              <div role="alert" class="mt-1 text-11-regular text-icon-critical-base">
                                {error()}
                              </div>
                            )}
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            </div>
          )}
        </Show>
      </main>

      <Show when={drawer()}>
        <aside class="w-72 shrink-0 overflow-y-auto border-l border-border-weaker-base bg-background-base p-3">
          <div class="mb-3 flex items-center justify-between gap-2">
            <div class="text-13-medium text-text-strong">{language.t("session.task.history")}</div>
            <Button variant="ghost" size="small" onClick={() => setDrawer(false)}>
              {language.t("common.close")}
            </Button>
          </div>
          <Show when={state.loading.history}>
            <div aria-live="polite" class="py-4 text-12-regular text-text-weak">
              {language.t("session.task.history.loading")}
            </div>
          </Show>
          <Show when={state.error.history}>
            {(err) => (
              <div role="alert" class="py-4 text-12-regular text-icon-critical-base">
                {err()}
              </div>
            )}
          </Show>
          <Show when={state.history.loaded && state.history.items.length === 0}>
            <div class="py-4 text-12-regular text-text-weak">{language.t("session.task.history.empty")}</div>
          </Show>
          <div class="flex flex-col gap-1">
            <For each={state.history.items}>
              {(item: History) => (
                <button
                  type="button"
                  class="rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-raised-base"
                  onClick={() => void revision(item.version)}
                >
                  <div class="text-12-medium text-text-strong">
                    {language.t("session.task.history.version", { version: item.version })} · {item.title}
                  </div>
                  <div class="mt-1 text-10-regular text-text-weak">
                    {stamp(item.time.archived ?? item.time.created, language.intl())}
                  </div>
                  <Show when={item.reason ?? item.archive_reason}>
                    {(reason) => <div class="mt-1 text-11-regular text-text-weak">{reason()}</div>}
                  </Show>
                  <Show when={item.terminal_status}>
                    {(status) => (
                      <div class="mt-1 text-10-regular text-text-weak">
                        {language.t("session.task.history.terminal", { status: language.t(labels[status()]) })}
                      </div>
                    )}
                  </Show>
                  <Show when={item.stopped_child_count !== undefined}>
                    <div class="mt-1 text-10-regular text-text-weak">
                      {language.t("session.task.history.stopped", { count: item.stopped_child_count ?? 0 })}
                    </div>
                  </Show>
                  <div class="mt-1 text-10-regular text-text-weak">
                    {language.t("session.task.history.result", {
                      status: language.t(
                        item.result.status ? archives[item.result.status] : "session.task.history.result.missing",
                      ),
                    })}
                  </div>
                </button>
              )}
            </For>
          </div>
          <Show when={state.loading.detail}>
            <div aria-live="polite" class="mt-3 text-12-regular text-text-weak">
              {language.t("session.task.detail.loading")}
            </div>
          </Show>
          <Show when={state.error.detail}>
            {(err) => (
              <div role="alert" class="mt-3 text-12-regular text-icon-critical-base">
                {err()}
              </div>
            )}
          </Show>
        </aside>
      </Show>
    </div>
  )
}
