import type { SessionLogResponse } from "@opencode-ai/sdk/v2/client"
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
type Log = SessionLogResponse[number]
type Stats = {
  requests: number
  tools: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
    total: number
  }
}

const label = (value: string) =>
  value
    .split(".")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")

const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const count = (value: unknown) => (typeof value === "number" ? value : undefined)
const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const list = (value: unknown) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])
const filled = (value: string | undefined): value is string => Boolean(value)

export function describeLog(record: Log): Summary {
  const data = record.data
  switch (record.type) {
    case "permission.asked":
      return {
        title: "Permission requested",
        detail: text(data.permission),
        meta: [
          `${count(data.patternCount) ?? 0} ${data.patternCount === 1 ? "pattern" : "patterns"}`,
          list(data.patternKinds).join(", "),
        ],
      }
    case "permission.replied":
      return {
        title: "Permission replied",
        detail: text(data.reply),
        meta: data.feedback ? ["feedback"] : [],
      }
    case "restore.completed":
      return {
        title: "Restore completed",
        detail: text(data.hash),
        meta: [],
      }
    case "workflow.started":
      return {
        title: "Workflow started",
        detail: text(data.workflowID),
        meta: [text(data.runID)].filter(filled),
      }
    case "workflow.paused":
      return {
        title: "Workflow paused",
        detail: text(data.step),
        meta: [text(data.status), text(data.workflowID), text(data.runID)].filter(filled),
      }
    case "workflow.completed":
      return {
        title: "Workflow completed",
        detail: text(data.workflowID),
        meta: [text(data.runID)].filter(filled),
      }
    case "workflow.failed":
      return {
        title: "Workflow failed",
        detail: text(data.step),
        meta: [text(data.workflowID), text(data.runID)].filter(filled),
      }
    case "memory.captured":
      return {
        title: "Memory captured",
        detail: `${count(data.count) ?? 0} ${data.count === 1 ? "memory" : "memories"}`,
        meta: [],
      }
    case "memory.failed":
      return {
        title: "Memory failed",
        detail: text(data.reason),
        meta: [],
      }
    case "llm.start":
      return {
        title: "LLM request started",
        detail: [text(data.providerID), text(data.modelID)].filter(filled).join(" / "),
        meta: [`${count(data.messages) ?? 0} messages`, `${count(data.tools) ?? 0} tools`],
      }
    case "llm.finish":
      return {
        title: "LLM request finished",
        detail: text(data.finish),
        meta: [`$${(count(data.cost) ?? 0).toFixed(4)}`],
      }
    case "llm.error":
      return {
        title: "LLM request failed",
        detail: text(data.error),
        meta: [],
      }
    case "llm.retry":
      return {
        title: "LLM request retrying",
        detail: text(data.message),
        meta: [`attempt ${count(data.attempt) ?? 0}`, `${count(data.delay) ?? 0}ms`],
      }
    case "tool.start":
      return {
        title: "Tool started",
        detail: text(data.tool),
        meta: [text(data.callID)].filter(filled),
      }
    case "tool.finish":
      return {
        title: "Tool finished",
        detail: text(data.title) ?? text(data.tool),
        meta: [text(data.callID)].filter(filled),
      }
    case "tool.error":
      return {
        title: "Tool failed",
        detail: text(data.error),
        meta: [text(data.tool), text(data.callID)].filter(filled),
      }
    case "reasoning.start":
      return { title: "Reasoning started", meta: [text(data.partID)].filter(filled) }
    case "reasoning.end":
      return { title: "Reasoning finished", meta: [`${count(data.chars) ?? 0} chars`] }
    case "text.start":
      return { title: "Text started", meta: [text(data.partID)].filter(filled) }
    case "text.end":
      return { title: "Text finished", meta: [`${count(data.chars) ?? 0} chars`] }
    case "step.start":
      return { title: "Step started", meta: [text(data.snapshot)].filter(filled) }
    case "step.finish":
      return {
        title: "Step finished",
        detail: text(data.reason),
        meta: [`$${(count(data.cost) ?? 0).toFixed(4)}`],
      }
  }

  return {
    title: label(record.type),
    meta: [],
  }
}

export function mergeLogs(current: Log[], incoming: Log[]) {
  const logs = new Map(incoming.map((log) => [log.id, log]))
  for (const log of current) logs.set(log.id, log)
  return [...logs.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
}

export function summarizeLogs(logs: Log[]): Stats {
  return logs.reduce<Stats>(
    (acc, log) => {
      if (log.type === "llm.start") acc.requests += 1
      if (log.type === "tool.start") acc.tools += 1
      if (log.type === "step.finish") {
        const tokens = object(log.data.tokens)
        const cache = object(tokens?.cache)
        acc.tokens.input += count(tokens?.input) ?? 0
        acc.tokens.output += count(tokens?.output) ?? 0
        acc.tokens.reasoning += count(tokens?.reasoning) ?? 0
        acc.tokens.cache.read += count(cache?.read) ?? 0
        acc.tokens.cache.write += count(cache?.write) ?? 0
        acc.tokens.total +=
          count(tokens?.total) ??
          (count(tokens?.input) ?? 0) +
            (count(tokens?.output) ?? 0) +
            (count(tokens?.reasoning) ?? 0) +
            (count(cache?.read) ?? 0) +
            (count(cache?.write) ?? 0)
      }
      return acc
    },
    {
      requests: 0,
      tools: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
        total: 0,
      },
    },
  )
}

export function SessionLogTimeline(props: { sessionID: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const limit = 200
  const [store, setStore] = createStore({
    loading: true,
    error: undefined as string | undefined,
    logs: [] as Log[],
    open: {} as Record<string, boolean>,
  })

  const rows = createMemo(() => store.logs.map((log) => ({ log, summary: describeLog(log) })))
  const stats = createMemo(() => summarizeLogs(store.logs))
  const time = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "medium" }))
  const num = createMemo(() => new Intl.NumberFormat(language.intl(), { notation: "compact" }))
  let seq = 0

  const load = async () => {
    const run = ++seq
    setStore({ loading: true, error: undefined })
    const logs: Log[] = []
    let cursor: string | undefined
    while (true) {
      const res = await sdk.client.session.log({ sessionID: props.sessionID, cursor, limit })
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
    setStore({ loading: true, error: undefined, logs: [], open: {} })
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
    const unsub = sdk.event.on("session.log.created", (event) => {
      const log = event.properties.info
      if (log.sessionID !== props.sessionID) return
      setStore("logs", reconcile(mergeLogs([log], store.logs)))
    })
    onCleanup(unsub)
  })

  return (
    <div class="h-full min-h-0 flex flex-col overflow-hidden bg-background-stronger">
      <div class="shrink-0 px-4 md:px-6 py-3 border-b border-border-weaker-base flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-14-medium text-text-strong">{language.t("session.logs.title")}</div>
          <div class="text-12-regular text-text-weak">
            {language.t("session.logs.count", { count: store.logs.length })}
          </div>
        </div>
        <div class="min-w-0 flex flex-wrap items-center justify-end gap-1.5">
          <Stat label={language.t("session.logs.stats.requests")} value={num().format(stats().requests)} />
          <Stat label={language.t("session.logs.stats.tools")} value={num().format(stats().tools)} />
          <Stat label={language.t("session.logs.stats.tokens")} value={num().format(stats().tokens.total)} />
          <Stat label={language.t("session.logs.stats.input")} value={num().format(stats().tokens.input)} />
          <Stat label={language.t("session.logs.stats.output")} value={num().format(stats().tokens.output)} />
          <Stat label={language.t("session.logs.stats.reasoning")} value={num().format(stats().tokens.reasoning)} />
          <Stat label={language.t("session.logs.stats.cacheRead")} value={num().format(stats().tokens.cache.read)} />
          <Stat label={language.t("session.logs.stats.cacheWrite")} value={num().format(stats().tokens.cache.write)} />
          <Button size="small" variant="ghost" disabled={store.loading} onClick={() => void load()}>
            {language.t("session.logs.refresh")}
          </Button>
        </div>
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
                          <div class="text-11-regular text-text-weaker">{label(row.log.type)}</div>
                          <div class="text-11-regular text-text-weaker">{row.log.level}</div>
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
                        <details
                          class="mt-2"
                          open={store.open[row.log.id] === true}
                          onToggle={(event) => setStore("open", row.log.id, event.currentTarget.open)}
                        >
                          <summary class="cursor-default text-11-regular text-text-weaker">
                            {language.t("session.logs.details")}
                          </summary>
                          <pre class="mt-2 overflow-auto rounded bg-background-base p-2 text-11-regular text-text-base">
                            {JSON.stringify(row.log.data, null, 2)}
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

function Stat(props: { label: string; value: string }) {
  return (
    <div class="shrink-0 rounded bg-surface-base px-2 py-1 text-11-regular text-text-weak tabular-nums">
      <span>{props.label}</span>
      <span class="ml-1 text-text-strong">{props.value}</span>
    </div>
  )
}
