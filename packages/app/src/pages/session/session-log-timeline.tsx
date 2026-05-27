import type { SessionLogResponse } from "@open-agent-harness/sdk/v2/client"
import { Button } from "@open-agent-harness/ui/button"
import { Markdown } from "@open-agent-harness/ui/markdown"
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
type Row = {
  id: string
  time: number
  level: Log["level"]
  type: string
  logs: Log[]
  summary: Summary
}
type Detail = {
  id: string
  type: string
  level: Log["level"]
  logs: Log[]
  summary: Summary
}
type Section = {
  id: string
  label: string
  data: unknown
}
type Filter = "all" | "protocol"
type Stats = {
  requests: number
  tools: number
  protocol: {
    runs: number
    internalTools: number
  }
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
const compact = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
const finish = (value: unknown) => {
  switch (value) {
    case "stop":
      return "Final"
    case "tool-calls":
      return "Tool call"
    case "length":
      return "Length limit"
    case "content-filter":
      return "Content filter"
    case "error":
      return "Error"
    case "other":
      return "Other"
    case "unknown":
      return "Unknown"
    default:
      return text(value)
  }
}
const inside = new Set([
  "step.start",
  "step.finish",
  "reasoning.start",
  "reasoning.end",
  "text.start",
  "text.end",
  "tool.input.start",
  "tool.start",
  "tool.finish",
  "tool.error",
])
const finals = new Set([
  "protocol.final.started",
  "protocol.final.completed",
  "protocol.final.malformed",
  "protocol.final.plain",
  "protocol.final.plain_tool_syntax",
])

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
    case "protocol.started":
      return {
        title: "Protocol started",
        detail: text(data.title),
        meta: [text(data.runID)].filter(filled),
      }
    case "protocol.action.completed":
      return {
        title: "Protocol action completed",
        detail: text(data.actionID),
        meta: [text(data.operation), text(data.runID)].filter(filled),
      }
    case "protocol.action.blocked":
      return {
        title: "Protocol action blocked",
        detail: text(data.actionID),
        meta: [text(data.operation), text(data.runID)].filter(filled),
      }
    case "protocol.action.failed":
      return {
        title: "Protocol action failed",
        detail: text(data.actionID),
        meta: [text(data.operation), text(data.runID)].filter(filled),
      }
    case "protocol.action.tool_call":
      return {
        title: "Protocol internal tool",
        detail: text(data.tool),
        meta: [text(data.actionID), text(data.callID)].filter(filled),
      }
    case "protocol.completed":
      return {
        title: "Protocol completed",
        detail: text(data.runID),
        meta: [],
      }
    case "protocol.failed":
      return {
        title: "Protocol failed",
        detail: text(data.runID),
        meta: [],
      }
    case "protocol.final.started":
      return {
        title: "Protocol final response started",
        detail: text(data.runID),
        meta: [text(data.sourceMessageID)].filter(filled),
      }
    case "protocol.final.completed":
      return {
        title: "Protocol final response completed",
        detail: text(data.runID),
        meta: [],
      }
    case "protocol.final.malformed":
      return {
        title: "Protocol final response malformed",
        detail: text(data.runID),
        meta: [],
      }
    case "protocol.final.plain":
      return {
        title: "Protocol final plain text",
        detail: text(data.runID),
        meta: [],
      }
    case "protocol.final.plain_tool_syntax":
      return {
        title: "Protocol final plain tool syntax",
        detail: text(data.runID),
        meta: [],
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
        title: "LLM Request",
        meta: [],
      }
    case "llm.finish":
      return {
        title: "LLM Response",
        meta: [finish(data.finish), `$${(count(data.cost) ?? 0).toFixed(4)}`].filter(filled),
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
      if (data.protocol === true) {
        return {
          title: "Protocol internal tool started",
          detail: text(data.tool),
          meta: [text(data.actionID), text(data.callID)].filter(filled),
        }
      }
      return {
        title: "Tool started",
        detail: text(data.tool),
        meta: [text(data.callID)].filter(filled),
      }
    case "tool.finish":
      if (data.protocol === true) {
        return {
          title: "Protocol internal tool finished",
          detail: text(data.title) ?? text(data.tool),
          meta: [text(data.actionID), text(data.callID)].filter(filled),
        }
      }
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
  return [...logs.values()].sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
}

const protocol = (log: Log) => log.type.startsWith("protocol.") || log.data.protocol === true
const noisy = (log: Log) => {
  if (log.type === "protocol.action.tool_call") return false
  if (log.type === "protocol.failed" || log.type === "protocol.action.failed" || log.type === "protocol.action.blocked") return false
  if (log.type === "protocol.final.malformed" || log.type === "protocol.final.plain_tool_syntax") return false
  if (log.type === "tool.error" && log.data.protocol === true) return false
  if (log.type.startsWith("protocol.")) return true
  return log.data.protocol === true
}

export function groupLogs(logs: Log[], filter: Filter = "all"): Row[] {
  const rows: Row[] = []
  const stream = new Map<string, Log[]>()
  const runs = new Map<string, Row>()
  const sorted = logs.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))

  for (const log of sorted) {
    if (filter === "protocol" && !protocol(log)) continue
    if (filter === "all" && noisy(log)) continue
    const key = log.messageID
    if (filter === "all" && finals.has(log.type)) {
      const run = text(log.data.runID)
      const row = run ? runs.get(run) : undefined
      if (row) {
        row.logs.push(log)
        continue
      }
    }
    if (log.type === "llm.start") {
      rows.push({
        id: log.id,
        time: log.time,
        level: log.level,
        type: log.type,
        logs: [log],
        summary: describeLog(log),
      })
      if (key) stream.set(key, [])
      continue
    }
    if (filter === "all" && log.type === "tool.error" && log.data.protocol === true) {
      rows.push({
        id: log.id,
        time: log.time,
        level: log.level,
        type: log.type,
        logs: [log],
        summary: describeLog(log),
      })
      continue
    }
    if (key && inside.has(log.type)) {
      stream.set(key, [...(stream.get(key) ?? []), log])
      continue
    }
    if (key && (log.type === "llm.finish" || log.type === "llm.error")) {
      const logs = [...(stream.get(key) ?? []), log]
      stream.delete(key)
      rows.push({
        id: log.id,
        time: Math.max(...logs.map((item) => item.time)),
        level: log.level,
        type: log.type,
        logs,
        summary: describeLog(log),
      })
      continue
    }
    const row = {
      id: log.id,
      time: log.time,
      level: log.level,
      type: log.type,
      logs: [log],
      summary: describeLog(log),
    }
    rows.push(row)
    if (log.type === "protocol.completed" || log.type === "protocol.failed") {
      const run = text(log.data.runID)
      if (run) runs.set(run, row)
    }
  }

  return rows.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
}

const ends: Record<string, string[]> = {
  "step.start": ["step.finish"],
  "reasoning.start": ["reasoning.end"],
  "text.start": ["text.end"],
  "tool.start": ["tool.finish", "tool.error"],
}

const pair = (start: Log, end: Log) => {
  const a = start.data
  const b = end.data
  const part = text(a.partID)
  const call = text(a.callID)
  if (part && text(b.partID) && part !== text(b.partID)) return false
  if (call && text(b.callID) && call !== text(b.callID)) return false
  return true
}

export function compactLogs(logs: Log[]): Detail[] {
  const out: Detail[] = []
  const used = new Set<string>()
  const sorted = logs.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
  for (const log of sorted) {
    if (used.has(log.id)) continue
    const choices = ends[log.type]
    if (!choices) {
      out.push({ id: log.id, type: log.type, level: log.level, logs: [log], summary: describeLog(log) })
      continue
    }
    const end = sorted.find((item) => !used.has(item.id) && choices.includes(item.type) && pair(log, item))
    if (!end) {
      out.push({ id: log.id, type: log.type, level: log.level, logs: [log], summary: describeLog(log) })
      continue
    }
    used.add(log.id)
    used.add(end.id)
    const first = describeLog(log)
    const last = describeLog(end)
    out.push({
      id: log.id,
      type: log.type,
      level: end.level === "error" ? end.level : log.level,
      logs: [log, end],
      summary: {
        title: label(log.type.replace(".start", "")),
        detail: last.detail ?? first.detail,
        meta: [...first.meta, ...last.meta].filter(filled),
      },
    })
  }
  return out
}

const raw = (logs: Log[]) =>
  logs.length === 1
    ? logs[0]?.data
    : logs.map((log) => ({
        time: log.time,
        level: log.level,
        type: log.type,
        data: log.data,
      }))

const output = (logs: Log[]) =>
  logs
    .filter((log) => log.type === "text.end")
    .map((log) => text(log.data.text))
    .filter(filled)
    .join("\n\n")

const reasoning = (logs: Log[]) =>
  logs
    .filter((log) => log.type === "reasoning.end")
    .map((log) => text(log.data.text))
    .filter(filled)
    .join("\n\n")

const blocks = (logs: Log[]) =>
  output(logs)
    .match(/```[^\n`]*agent-protocol[^\n`]*\n[\s\S]*?```/g)
    ?.join("\n\n") ?? ""

const records = (logs: Log[], names: string[]) =>
  logs
    .filter((log) => names.includes(log.type))
    .map((log) => ({
      time: log.time,
      type: log.type,
      data: log.data,
    }))

export function detailSections(logs: Log[]): Section[] {
  const start = logs.find((log) => log.type === "llm.start")
  const done = logs.find((log) => log.type === "llm.finish")
  const err = logs.find((log) => log.type === "llm.error")
  const out = output(logs)
  const thoughts = reasoning(logs)
  const protocol = blocks(logs)
  const steps = records(logs, ["step.start", "step.finish"])
  const tools = records(logs, ["tool.input.start", "tool.start", "tool.finish", "tool.error"])
  if (start) {
    const data = start.data
    const req = object(data.request) ?? {}
    return [
      {
        id: "overview",
        label: "Overview",
        data: compact({
          providerID: data.providerID,
          modelID: data.modelID,
          agent: data.agent,
          mode: data.mode,
          attempt: data.attempt,
          toolChoice: req.toolChoice,
          error: err?.data.error,
        }),
      },
      {
        id: "system",
        label: "System",
        data: req.system ?? [],
      },
      {
        id: "messages",
        label: "Messages",
        data: req.messages ?? [],
      },
      {
        id: "user",
        label: "User",
        data: req.user ?? {},
      },
      {
        id: "tools",
        label: "Tools",
        data: compact({
          available: req.tools ?? [],
          toolChoice: req.toolChoice,
        }),
      },
      {
        id: "raw",
        label: "Raw",
        data: raw(logs),
      },
    ]
  }
  if (done) {
    return [
      {
        id: "overview",
        label: "Overview",
        data: compact({
          finish: done.data.finish,
          status: finish(done.data.finish),
          cost: done.data.cost,
        }),
      },
      ...(out
        ? [
            {
              id: "text",
              label: "Text",
              data: out,
            },
          ]
        : []),
      ...(thoughts
        ? [
            {
              id: "reasoning",
              label: "Reasoning",
              data: thoughts,
            },
          ]
        : []),
      ...(protocol
        ? [
            {
              id: "protocol",
              label: "Protocol",
              data: protocol,
            },
          ]
        : []),
      ...(tools.length > 0
        ? [
            {
              id: "tools",
              label: "Tools",
              data: tools,
            },
          ]
        : []),
      ...(steps.length > 0
        ? [
            {
              id: "steps",
              label: "Steps",
              data: steps,
            },
          ]
        : []),
      {
        id: "tokens",
        label: "Tokens",
        data: object(done.data.tokens) ?? {},
      },
      {
        id: "raw",
        label: "Raw",
        data: raw(logs),
      },
    ]
  }
  return [{ id: "raw", label: "Raw", data: raw(logs) }]
}

export function summarizeLogs(logs: Log[]): Stats {
  const runs = new Set<string>()
  return logs.reduce<Stats>(
    (acc, log) => {
      if (log.type === "llm.start") acc.requests += 1
      if (log.type === "tool.start" && log.data.protocol !== true) acc.tools += 1
      if (log.type.startsWith("protocol.")) {
        const id = text(log.data.runID)
        if (id) {
          runs.add(id)
          acc.protocol.runs = runs.size
        }
      }
      if (log.type === "protocol.action.tool_call") acc.protocol.internalTools += 1
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
      protocol: {
        runs: 0,
        internalTools: 0,
      },
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

function Preview(props: { data: unknown }) {
  const value = () => props.data
  const line = (input: string) => input.replaceAll("\\n", "\n").replaceAll("\\t", "\t")
  const json = () => line(JSON.stringify(value(), null, 2))
  const str = () => (typeof value() === "string" ? line(value() as string) : undefined)
  const md = () => {
    const text = str()
    if (!text) return false
    return /(^|\n)(#|```|[-*] |\d+\. |\|.+\|)/.test(text)
  }
  return (
    <Show
      when={str()}
      fallback={
        <pre class="rounded bg-background-base p-2 text-11-regular text-text-base whitespace-pre-wrap break-words">
          {json()}
        </pre>
      }
    >
      {(text) => (
        <Show
          when={md()}
          fallback={
            <pre class="rounded bg-background-base p-2 text-11-regular text-text-base whitespace-pre-wrap break-words">
              {text()}
            </pre>
          }
        >
          <div class="rounded bg-background-base p-2 text-12-regular text-text-base break-words">
            <Markdown text={text()} />
          </div>
        </Show>
      )}
    </Show>
  )
}

function Data(props: { section: Section; sections: Section[]; onSection: (id: string) => void }) {
  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show when={props.sections.length > 1}>
        <div class="shrink-0 border-b border-border-weaker-base bg-background-base pb-2">
          <div class="flex flex-wrap gap-1.5">
          <For each={props.sections}>
            {(section) => (
              <button
                type="button"
                class="rounded px-2 py-1 text-11-regular transition-colors"
                classList={{
                  "bg-surface-base text-text-strong": props.section.id === section.id,
                  "text-text-weak hover:bg-surface-base": props.section.id !== section.id,
                }}
                onClick={() => props.onSection(section.id)}
              >
                {section.label}
              </button>
            )}
          </For>
          </div>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-auto pt-2">
        <Preview data={props.section.data} />
      </div>
    </div>
  )
}

export function preserveScroll(
  scroller: Pick<HTMLDivElement, "scrollTop" | "scrollHeight"> | undefined,
  update: () => void,
) {
  const top = scroller?.scrollTop ?? 0
  const height = scroller?.scrollHeight ?? 0
  update()
  if (!scroller || top <= 4) return
  queueMicrotask(() => {
    scroller.scrollTop = top + Math.max(0, scroller.scrollHeight - height)
  })
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
    detail: {} as Record<string, string>,
    filter: "all" as Filter,
  })

  const rows = createMemo(() => groupLogs(store.logs, store.filter))
  const stats = createMemo(() => summarizeLogs(store.logs))
  const time = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "medium" }))
  const num = createMemo(() => new Intl.NumberFormat(language.intl(), { notation: "compact" }))
  let seq = 0
  let scroller: HTMLDivElement | undefined

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
    setStore({ loading: true, error: undefined, logs: [], open: {}, detail: {} })
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
      preserveScroll(scroller, () => setStore("logs", reconcile(mergeLogs([log], store.logs))))
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
          <button
            type="button"
            class="rounded px-2 py-1 text-11-regular transition-colors"
            classList={{
              "bg-surface-base text-text-strong": store.filter === "all",
              "text-text-weak hover:bg-surface-base": store.filter !== "all",
            }}
            onClick={() => setStore("filter", "all")}
          >
            All
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 text-11-regular transition-colors"
            classList={{
              "bg-surface-base text-text-strong": store.filter === "protocol",
              "text-text-weak hover:bg-surface-base": store.filter !== "protocol",
            }}
            onClick={() => setStore("filter", "protocol")}
          >
            Protocol
          </button>
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
            <div ref={scroller} class="min-h-0 flex-1 overflow-auto px-4 md:px-6 py-4" data-scrollable>
              <div class="flex flex-col">
                <For each={rows()}>
                  {(row) => {
                    const sections = detailSections(row.logs)
                    const current = () => sections.find((item) => item.id === store.detail[row.id]) ?? sections[0]
                    const section = () => current() ?? { id: "raw", label: "Raw", data: raw(row.logs) }
                    const open = () => store.open[row.id] === true
                    const toggle = () => setStore("open", row.id, !open())
                    return (
                      <div
                        class="grid cursor-default grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border-weaker-base pt-4 pb-5 last:pb-0"
                        role="button"
                        tabIndex={0}
                        aria-expanded={open()}
                        onClick={toggle}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return
                          event.preventDefault()
                          toggle()
                        }}
                      >
                        <div class="text-11-regular text-text-weak tabular-nums pt-0.5">
                          {time().format(new Date(row.time))}
                        </div>
                        <div class="min-w-0 -mt-0.5">
                          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <div class="min-w-0 text-13-medium text-text-strong break-words">{row.summary.title}</div>
                            <div class="text-11-regular text-text-weaker break-words">{row.level}</div>
                          </div>
                          <Show when={row.summary.detail}>
                            <div class="mt-1 text-12-regular text-text-base break-words">{row.summary.detail}</div>
                          </Show>
                        </div>
                        <Show when={open()}>
                          <div
                            class="col-span-2 mr-5 h-[calc(100vh-18rem)] min-h-80 rounded border border-border-weaker-base bg-background-base px-3 py-3"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <Data
                              sections={sections}
                              section={section()}
                              onSection={(id) => setStore("detail", row.id, id)}
                            />
                          </div>
                        </Show>
                      </div>
                    )
                  }}
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
