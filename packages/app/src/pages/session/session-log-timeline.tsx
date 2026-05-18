import type { AuditRecord } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"

type Summary = {
  title: string
  detail?: string
  meta: string[]
}

const label = (value: string) =>
  value
    .split(".")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")

export function describeLog(record: AuditRecord): Summary {
  const event = record.event
  switch (event.type) {
    case "permission.asked":
      return {
        title: "Permission requested",
        detail: event.permission,
        meta: [
          `${event.patternCount} ${event.patternCount === 1 ? "pattern" : "patterns"}`,
          event.patternKinds.join(", "),
        ],
      }
    case "permission.replied":
      return {
        title: "Permission replied",
        detail: event.reply,
        meta: event.feedback ? ["feedback"] : [],
      }
    case "restore.completed":
      return {
        title: "Restore completed",
        detail: event.hash,
        meta: [],
      }
    case "workflow.started":
      return {
        title: "Workflow started",
        detail: event.workflowID,
        meta: [event.runID],
      }
    case "workflow.paused":
      return {
        title: "Workflow paused",
        detail: event.step,
        meta: [event.status, event.workflowID, event.runID],
      }
    case "workflow.completed":
      return {
        title: "Workflow completed",
        detail: event.workflowID,
        meta: [event.runID],
      }
    case "workflow.failed":
      return {
        title: "Workflow failed",
        detail: event.step,
        meta: [event.workflowID, event.runID],
      }
    case "memory.captured":
      return {
        title: "Memory captured",
        detail: `${event.count} ${event.count === 1 ? "memory" : "memories"}`,
        meta: [],
      }
    case "memory.failed":
      return {
        title: "Memory failed",
        detail: event.reason,
        meta: [],
      }
  }
}

export function mergeLogs(current: AuditRecord[], incoming: AuditRecord[]) {
  const logs = new Map(incoming.map((log) => [log.id, log]))
  for (const log of current) logs.set(log.id, log)
  return [...logs.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
}

export function SessionLogTimeline(props: { sessionID: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const limit = 200
  const [store, setStore] = createStore({
    loading: true,
    error: undefined as string | undefined,
    logs: [] as AuditRecord[],
  })

  const rows = createMemo(() => store.logs.map((log) => ({ log, summary: describeLog(log) })))
  const time = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "medium" }))
  let seq = 0

  const load = async () => {
    const run = ++seq
    setStore({ loading: true, error: undefined })
    const logs: AuditRecord[] = []
    let cursor: string | undefined
    while (true) {
      const res = await sdk.client.audit.list({ sessionID: props.sessionID, cursor, limit })
      const next = res.data ?? []
      logs.push(...next)
      if (next.length < limit) break
      cursor = next.at(-1)?.id
      if (!cursor) break
    }
    if (run !== seq) return
    setStore("logs", reconcile(mergeLogs(logs, [])))
    setStore("loading", false)
  }

  createEffect(() => {
    let active = true
    props.sessionID
    setStore({ loading: true, error: undefined, logs: [] })
    void load().catch((err) => {
      if (!active) return
      setStore({
        loading: false,
        error: formatServerError(err, language.t, language.t("session.logs.error")),
      })
    })
    onCleanup(() => {
      active = false
      seq += 1
    })
  })

  createEffect(() => {
    const unsub = sdk.event.on("observability.audit.recorded", (event) => {
      const log = event.properties
      if (log.sessionID !== props.sessionID) return
      setStore("logs", reconcile(mergeLogs([log], store.logs)))
    })
    onCleanup(unsub)
  })

  return (
    <div class="h-full min-h-0 flex flex-col overflow-hidden bg-background-stronger">
      <div class="shrink-0 px-4 md:px-6 py-3 border-b border-border-weaker-base flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-14-medium text-text-strong">{language.t("session.logs.title")}</div>
          <div class="text-12-regular text-text-weak">
            {language.t("session.logs.count", { count: store.logs.length })}
          </div>
        </div>
        <Button size="small" variant="ghost" disabled={store.loading} onClick={() => void load()}>
          {language.t("session.logs.refresh")}
        </Button>
      </div>

      <Show
        when={!store.loading}
        fallback={
          <div class="px-4 md:px-6 py-4 text-13-regular text-text-weak">{language.t("session.logs.loading")}</div>
        }
      >
        <Show
          when={!store.error}
          fallback={
            <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-4 px-6">
              <div class="text-14-regular text-text-weak max-w-72">{store.error}</div>
              <Button size="small" variant="ghost" onClick={() => void load()}>
                {language.t("session.logs.refresh")}
              </Button>
            </div>
          }
        >
          <Show
            when={rows().length > 0}
            fallback={
              <div class="h-full pb-64 -mt-4 flex items-center justify-center text-center px-6">
                <div class="text-14-regular text-text-weak max-w-72">{language.t("session.logs.empty")}</div>
              </div>
            }
          >
            <div class="min-h-0 flex-1 overflow-auto px-4 md:px-6 py-4" data-scrollable>
              <div class="flex flex-col">
                <For each={rows()}>
                  {(row) => (
                    <div class="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-4 border-l border-border-weaker-base pl-4 pb-5 last:pb-0">
                      <div class="text-11-regular text-text-weak tabular-nums pt-0.5">
                        {time().format(new Date(row.log.time))}
                      </div>
                      <div class="min-w-0 -mt-0.5">
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <div class="text-13-medium text-text-strong">{row.summary.title}</div>
                          <div class="text-11-regular text-text-weaker">{label(row.log.event.type)}</div>
                        </div>
                        <Show when={row.summary.detail}>
                          <div class="mt-1 text-12-regular text-text-base break-words">{row.summary.detail}</div>
                        </Show>
                        <Show when={row.summary.meta.length > 0}>
                          <div class="mt-2 flex flex-wrap gap-1.5">
                            <For each={row.summary.meta.filter(Boolean)}>
                              {(item) => (
                                <span class="px-1.5 py-0.5 rounded bg-surface-base text-11-regular text-text-weak">
                                  {item}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                        <details class="mt-2">
                          <summary class="cursor-default text-11-regular text-text-weaker">
                            {language.t("session.logs.details")}
                          </summary>
                          <pre class="mt-2 overflow-auto rounded bg-background-base p-2 text-11-regular text-text-base">
                            {JSON.stringify(row.log.event, null, 2)}
                          </pre>
                        </details>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
