import type { SessionRunDocumentResponse, SessionRunsResponse } from "@open-agent-harness/sdk/v2/client"
import { Button } from "@open-agent-harness/ui/button"
import { Markdown } from "@open-agent-harness/ui/markdown"
import { For, Show, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { groups, progress, task } from "@/pages/session/session-runs-data"
import { formatServerError } from "@/utils/server-errors"

type Run = SessionRunsResponse[number]
type Action = Run["actions"][number]
type Doc = NonNullable<Run["documents"]>[number]

const tone = (status: Run["status"] | Action["status"]) => {
  if (status === "completed") return "text-icon-success-base bg-surface-success-base/20"
  if (status === "failed" || status === "blocked") return "text-icon-critical-base bg-surface-critical-weak"
  if (status === "running") return "text-icon-info-base bg-surface-info-base/20"
  return "text-text-weak bg-surface-raised-base"
}

const time = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)

export function SessionRuns(props: { sessionID: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore({
    runs: [] as Run[],
    selected: undefined as string | undefined,
    doc: undefined as SessionRunDocumentResponse | undefined,
    loading: true,
    reading: undefined as string | undefined,
    error: undefined as string | undefined,
    docError: undefined as string | undefined,
  })

  const selected = () => state.runs.find((run) => run.run_id === state.selected)

  const load = async (id: string) => {
    setState({
      runs: [],
      selected: undefined,
      loading: true,
      reading: undefined,
      error: undefined,
      doc: undefined,
      docError: undefined,
    })
    try {
      const res = await sdk.client.session.runs({ sessionID: id })
      if (props.sessionID !== id) return
      const runs = res.data ?? []
      setState({ runs, selected: runs[0]?.run_id, loading: false })
    } catch (err) {
      if (props.sessionID !== id) return
      setState({
        runs: [],
        selected: undefined,
        loading: false,
        error: formatServerError(err, language.t, language.t("session.runs.error")),
      })
    }
  }

  const open = async (run: Run, doc: Doc) => {
    setState({ reading: doc.path, doc: undefined, docError: undefined })
    try {
      const res = await sdk.client.session.run2.document({
        sessionID: props.sessionID,
        runID: run.run_id,
        path: doc.path,
      })
      if (state.selected !== run.run_id || state.reading !== doc.path) return
      setState({ doc: res.data, reading: undefined })
    } catch (err) {
      if (state.selected !== run.run_id || state.reading !== doc.path) return
      setState({
        reading: undefined,
        docError: formatServerError(err, language.t, language.t("session.runs.documentError")),
      })
    }
  }

  createEffect(() => void load(props.sessionID))

  return (
    <div class="flex h-full min-h-0 bg-background-stronger" data-component="session-runs">
      <aside class="w-64 shrink-0 overflow-y-auto border-r border-border-weaker-base bg-background-base p-3">
        <div class="mb-3 flex items-center justify-between gap-2">
          <div>
            <div class="text-14-medium text-text-strong">{language.t("session.runs.title")}</div>
            <div class="text-11-regular text-text-weak">
              {language.t("session.runs.count", { count: state.runs.length })}
            </div>
          </div>
          <Button variant="ghost" size="small" onClick={() => void load(props.sessionID)} disabled={state.loading}>
            {language.t("session.runs.refresh")}
          </Button>
        </div>

        <Show when={state.loading}>
          <div class="py-4 text-12-regular text-text-weak">{language.t("session.runs.loading")}</div>
        </Show>
        <Show when={state.error}>
          {(error) => <div class="py-4 text-12-regular text-icon-critical-base">{error()}</div>}
        </Show>
        <Show when={!state.loading && !state.error && state.runs.length === 0}>
          <div class="py-4 text-12-regular text-text-weak">{language.t("session.runs.empty")}</div>
        </Show>

        <div class="flex flex-col gap-1">
          <For each={state.runs}>
            {(run) => (
              <button
                type="button"
                class="rounded-md px-2.5 py-2 text-left transition-colors"
                classList={{
                  "bg-surface-raised-base": state.selected === run.run_id,
                  "hover:bg-surface-raised-base/50": state.selected !== run.run_id,
                }}
                onClick={() =>
                  setState({ selected: run.run_id, reading: undefined, doc: undefined, docError: undefined })
                }
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 truncate text-12-medium text-text-strong">{run.title ?? run.run_id}</div>
                  <span class={`shrink-0 rounded px-1.5 py-0.5 text-10-medium ${tone(run.status)}`}>{run.status}</span>
                </div>
                <div class="mt-1 text-10-regular text-text-weak">{time(run.time.started)}</div>
                <div class="mt-1 text-10-regular text-text-weak">
                  {language.t("session.runs.summary", {
                    done: progress(run.actions).done,
                    tasks: run.actions.length,
                    documents: run.documents?.length ?? 0,
                  })}
                </div>
              </button>
            )}
          </For>
        </div>
      </aside>

      <main class="min-w-0 flex-1 overflow-y-auto">
        <Show when={selected()}>
          {(run) => (
            <Show
              when={state.doc}
              fallback={
                <div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-5">
                  <section>
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <h2 class="text-16-medium text-text-strong">{run().title ?? run().run_id}</h2>
                        <div class="mt-1 font-mono text-10-regular text-text-weak">{run().run_id}</div>
                      </div>
                      <span class={`rounded px-2 py-1 text-11-medium ${tone(run().status)}`}>{run().status}</span>
                    </div>
                    <Show when={run().summary}>
                      <p class="mt-3 text-13-regular text-text-base">{run().summary}</p>
                    </Show>
                  </section>

                  <section>
                    <h3 class="mb-2 text-13-medium text-text-strong">{language.t("session.runs.tasks")}</h3>
                    <div class="flex flex-col gap-2">
                      <For each={run().actions}>
                        {(action) => (
                          <article class="rounded-md border border-border-weaker-base bg-background-base p-3">
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <div class="text-12-medium text-text-strong">{action.title}</div>
                                <div class="mt-0.5 text-10-regular text-text-weak">
                                  {action.executor.target ?? action.executor.type} · {action.operation}
                                </div>
                              </div>
                              <span class={`shrink-0 rounded px-1.5 py-0.5 text-10-medium ${tone(action.status)}`}>
                                {action.status}
                              </span>
                            </div>
                            <Show when={task(action)}>
                              {(value) => (
                                <pre class="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-background-stronger p-2 text-11-regular text-text-base">
                                  {value()}
                                </pre>
                              )}
                            </Show>
                            <Show when={action.summary ?? action.error}>
                              <div class="mt-2 text-11-regular text-text-weak">{action.error ?? action.summary}</div>
                            </Show>
                            <Show when={(action.depends_on?.length ?? 0) > 0}>
                              <div class="mt-2 text-10-regular text-text-weak">
                                {language.t("session.runs.depends", { ids: action.depends_on?.join(", ") ?? "" })}
                              </div>
                            </Show>
                          </article>
                        )}
                      </For>
                    </div>
                  </section>

                  <section>
                    <h3 class="mb-2 text-13-medium text-text-strong">{language.t("session.runs.documents")}</h3>
                    <Show
                      when={(run().documents?.length ?? 0) > 0}
                      fallback={
                        <div class="text-12-regular text-text-weak">{language.t("session.runs.noDocuments")}</div>
                      }
                    >
                      <div class="flex flex-col gap-4">
                        <For each={groups(run().documents ?? [])}>
                          {(group) => (
                            <div>
                              <div class="mb-1.5 text-10-medium uppercase text-text-weak">{group.type}</div>
                              <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                                <For each={group.documents}>
                                  {(doc) => (
                                    <button
                                      type="button"
                                      class="rounded-md border border-border-weaker-base bg-background-base p-3 text-left transition-colors hover:bg-surface-raised-base"
                                      onClick={() => void open(run(), doc)}
                                    >
                                      <div class="truncate text-12-medium text-text-strong">{doc.name}</div>
                                      <div class="mt-1 truncate font-mono text-10-regular text-text-weak">
                                        {doc.path}
                                      </div>
                                    </button>
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={state.reading}>
                      <div class="mt-3 text-12-regular text-text-weak">
                        {language.t("session.runs.documentLoading")}
                      </div>
                    </Show>
                    <Show when={state.docError}>
                      {(error) => <div class="mt-3 text-12-regular text-icon-critical-base">{error()}</div>}
                    </Show>
                  </section>
                </div>
              }
            >
              {(doc) => (
                <div class="mx-auto w-full max-w-4xl px-6 py-5">
                  <div class="mb-4 flex items-start justify-between gap-3 border-b border-border-weaker-base pb-3">
                    <div>
                      <div class="text-14-medium text-text-strong">{doc().document.name}</div>
                      <div class="mt-1 font-mono text-10-regular text-text-weak">{doc().document.path}</div>
                    </div>
                    <Button variant="ghost" size="small" onClick={() => setState("doc", undefined)}>
                      {language.t("session.runs.back")}
                    </Button>
                  </div>
                  <Markdown text={doc().body} />
                </div>
              )}
            </Show>
          )}
        </Show>
      </main>
    </div>
  )
}
