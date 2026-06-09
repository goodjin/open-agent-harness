import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ConsoleMessage, Page, Request, Response } from "@playwright/test"
import { seedProjects, withSession } from "../actions"
import { test, expect } from "../fixtures"
import { promptSelector, sessionItemSelector } from "../selectors"
import { createSdk, serverUrl, sessionPath } from "../utils"

type Row = {
  id: number
  method: string
  url: string
  host: string
  path: string
  query: string
  type: string
  api: boolean
  bucket: string
  name: string
  body: string
  key: string
  stream: boolean
  start: number
  ttfb?: number
  total?: number
  status?: number
  fail?: string
}

type Need = {
  key: string
  label: string
  required: boolean
  match: (row: Row) => boolean
}

type Check = {
  key: string
  ok: boolean
  note: string
}

const NOISE = new Set(["_", "t", "ts", "cache", "cachebust"])
const STREAM = new Set(["/global/event", "/event"])
const REQUIRED: Need[] = [
  { key: "health", label: "server health", required: true, match: (row) => row.path === "/global/health" },
  { key: "event", label: "global event stream", required: true, match: (row) => row.path === "/global/event" },
  { key: "path", label: "path/worktree identity", required: true, match: (row) => row.path === "/path" },
  { key: "global-config", label: "global config", required: true, match: (row) => row.path === "/global/config" },
  { key: "project-list", label: "project list", required: true, match: (row) => row.path === "/project" },
  { key: "provider-list", label: "provider list", required: true, match: (row) => row.path === "/provider" },
  { key: "provider-auth", label: "provider auth", required: true, match: (row) => row.path === "/provider/auth" },
  { key: "project-current", label: "current project", required: true, match: (row) => row.path === "/project/current" },
  { key: "config", label: "directory config", required: true, match: (row) => row.path === "/config" },
  { key: "agent", label: "agent list", required: true, match: (row) => row.path === "/agent" },
  { key: "session-status", label: "session status map", required: true, match: (row) => row.path === "/session/status" },
  {
    key: "session-list",
    label: "root session list",
    required: true,
    match: (row) => row.method === "GET" && row.path === "/session",
  },
  { key: "session-tree", label: "session tree children", required: false, match: (row) => row.path === "/session/tree" },
  {
    key: "session-message",
    label: "opened session messages",
    required: true,
    match: (row) => /^\/session\/[^/]+\/message$/.test(row.path),
  },
  { key: "command", label: "command list", required: true, match: (row) => row.path === "/command" },
  { key: "mcp", label: "mcp status", required: true, match: (row) => row.path === "/mcp" },
  { key: "lsp", label: "lsp status", required: true, match: (row) => row.path === "/lsp" },
  { key: "vcs", label: "vcs status", required: true, match: (row) => row.path === "/vcs" },
  { key: "permission", label: "permission requests", required: true, match: (row) => row.path === "/permission" },
  { key: "question", label: "question requests", required: true, match: (row) => row.path === "/question" },
]

const ok = (row: Row) => row.status !== undefined && row.status < 400 && !row.fail
const ms = (value: number | undefined) => Math.round(value ?? 0)
const mark = (value: boolean) => (value ? "ok" : "missing")
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12)

function route(url: URL, api: boolean, type: string) {
  if (!api) {
    if (type === "document") return { bucket: "document", name: "app document" }
    if (type === "script" || url.pathname.includes("/@vite/")) return { bucket: "asset", name: "script/module" }
    if (type === "stylesheet") return { bucket: "asset", name: "stylesheet" }
    if (type === "font") return { bucket: "asset", name: "font" }
    if (type === "image" || type === "media") return { bucket: "asset", name: type }
    return { bucket: "other", name: type || "browser request" }
  }

  const p = url.pathname
  if (STREAM.has(p)) return { bucket: "stream", name: "event stream" }
  if (p.startsWith("/global/")) return { bucket: "global", name: p.slice(1) }
  if (p === "/path") return { bucket: "global", name: "path" }
  if (p.startsWith("/project")) return { bucket: "project", name: p.slice(1) }
  if (p.startsWith("/provider")) return { bucket: "provider", name: p.slice(1) }
  if (p === "/config" || p.startsWith("/config/")) return { bucket: "config", name: p.slice(1) }
  if (p.startsWith("/agent")) return { bucket: "agent", name: p.slice(1) }
  if (p.startsWith("/session")) return { bucket: "session", name: p.slice(1) }
  if (p.startsWith("/file")) return { bucket: "file", name: p.slice(1) }
  if (p.startsWith("/worktree")) return { bucket: "worktree", name: p.slice(1) }
  if (p.startsWith("/permission")) return { bucket: "permission", name: p.slice(1) }
  if (p.startsWith("/question")) return { bucket: "question", name: p.slice(1) }
  if (p === "/command") return { bucket: "command", name: "command" }
  if (p === "/mcp" || p.startsWith("/mcp/")) return { bucket: "mcp", name: p.slice(1) }
  if (p === "/lsp" || p.startsWith("/lsp/")) return { bucket: "lsp", name: p.slice(1) }
  if (p === "/vcs" || p.startsWith("/vcs/")) return { bucket: "vcs", name: p.slice(1) }
  if (p.startsWith("/harness")) return { bucket: "harness", name: p.slice(1) }
  return { bucket: "api-other", name: p.slice(1) || "api" }
}

function norm(url: URL, method: string, body: string) {
  const next = new URL(url.toString())
  for (const key of NOISE) next.searchParams.delete(key)
  next.searchParams.sort()
  const suffix = method === "GET" || !body ? "" : `#${hash(body)}`
  return `${method} ${next.origin}${next.pathname}${next.search}${suffix}`
}

function row(id: number, req: Request, api: URL) {
  const raw = req.url()
  const url = raw.startsWith("http") ? new URL(raw) : new URL(`http://browser.local/${encodeURIComponent(raw)}`)
  const type = req.resourceType()
  const hit = url.origin === api.origin
  const body = req.postData() ?? ""
  const next = route(url, hit, type)
  return {
    id,
    method: req.method(),
    url: url.toString(),
    host: url.host,
    path: url.pathname,
    query: url.search,
    type,
    api: hit,
    bucket: next.bucket,
    name: next.name,
    body: body ? hash(body) : "",
    key: norm(url, req.method(), body),
    stream: hit && STREAM.has(url.pathname),
    start: performance.now(),
  } satisfies Row
}

function bucket(rows: Row[]) {
  const keys = [...new Set(rows.map((item) => item.bucket))].sort()
  return keys.map((key) => {
    const set = rows.filter((item) => item.bucket === key)
    const times = set.map((item) => item.total ?? item.ttfb ?? 0).filter((item) => item > 0)
    const sorted = times.slice().sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
    return {
      bucket: key,
      count: set.length,
      errors: set.filter((item) => item.fail || (item.status ?? 0) >= 400).length,
      avg_ms: ms(times.reduce((sum, item) => sum + item, 0) / Math.max(times.length, 1)),
      p95_ms: ms(p95),
      max_ms: ms(Math.max(0, ...times)),
    }
  })
}

function dupes(rows: Row[]) {
  const map = rows
    .filter((item) => item.api && !item.stream)
    .reduce<Record<string, Row[]>>((acc, item) => {
      acc[item.key] = [...(acc[item.key] ?? []), item]
      return acc
    }, {})
  return Object.entries(map)
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({
      key,
      count: items.length,
      bucket: items[0]?.bucket ?? "unknown",
      ids: items.map((item) => item.id),
      max_ms: ms(Math.max(...items.map((item) => item.total ?? item.ttfb ?? 0))),
    }))
    .sort((a, b) => b.count - a.count || b.max_ms - a.max_ms)
}

function shape(row: Row) {
  if (!row.api || row.stream) return
  const url = new URL(row.url)
  const path = (() => {
    if (row.path === "/session/tree") return "/session/tree"
    if (/^\/session\/[^/]+\/message$/.test(row.path)) return "/session/:id/message"
    if (/^\/session\/[^/]+\/(diff|todo|log|status|children|descendants)$/.test(row.path)) {
      return row.path.replace(/^\/session\/[^/]+\//, "/session/:id/")
    }
    return row.path
  })()
  if (path === row.path && !url.searchParams.has("root")) return

  for (const key of [...NOISE, "root", "before"]) url.searchParams.delete(key)
  url.searchParams.sort()
  return `${row.method} ${url.origin}${path}${url.search}`
}

function fanout(rows: Row[]) {
  const map = rows.reduce<Record<string, Row[]>>((acc, item) => {
    const key = shape(item)
    if (!key) return acc
    acc[key] = [...(acc[key] ?? []), item]
    return acc
  }, {})
  return Object.entries(map)
    .filter(([, items]) => items.length >= Number(process.env.OPENCODE_E2E_AUDIT_FANOUT_MIN ?? 10))
    .map(([key, items]) => ({
      key,
      count: items.length,
      bucket: items[0]?.bucket ?? "unknown",
      ids: items.map((item) => item.id),
      max_ms: ms(Math.max(...items.map((item) => item.total ?? item.ttfb ?? 0))),
      total_ms: ms(items.reduce((sum, item) => sum + (item.total ?? item.ttfb ?? 0), 0)),
      examples: items.slice(0, 5).map((item) => `${item.method} ${item.path}${item.query}`),
    }))
    .sort((a, b) => b.count - a.count || b.total_ms - a.total_ms)
}

function coverage(rows: Row[]) {
  return REQUIRED.map((need) => {
    const hits = rows.filter((item) => need.match(item) && ok(item))
    return {
      key: need.key,
      label: need.label,
      required: need.required,
      status: mark(hits.length > 0),
      count: hits.length,
    }
  })
}

function advice(input: {
  dupes: ReturnType<typeof dupes>
  fanout: ReturnType<typeof fanout>
  slow: Row[]
  summary: ReturnType<typeof bucket>
}) {
  const notes: string[] = []
  if (input.dupes.length > 0) {
    notes.push("Duplicate API requests were observed; first check startup in-flight reuse and resource-level caching.")
  }
  if (input.fanout.some((item) => item.key.includes("/session/tree"))) {
    notes.push("Session tree requests fan out by root session; consider batching descendants or lazy-loading child trees.")
  }
  if (input.slow.some((item) => item.bucket === "session")) {
    notes.push("Session requests are among the slowest calls; review list/tree/message batching and prefetch duplication.")
  }
  if (input.slow.some((item) => item.bucket === "vcs" || item.bucket === "lsp" || item.bucket === "mcp")) {
    notes.push("Status probes are among the slowest calls; consider moving them behind first paint or background refresh.")
  }
  if ((input.summary.find((item) => item.bucket === "asset")?.count ?? 0) > 80) {
    notes.push("Dev-mode asset request count is high; compare against a production build before making bundle conclusions.")
  }
  if (notes.length === 0) notes.push("No obvious duplicate or slow-request concentration was found in this sample.")
  return notes
}

function markdown(data: ReturnType<typeof report>) {
  const rowline = (row: Row) =>
    `| ${row.id} | ${row.method} | ${row.status ?? "-"} | ${ms(row.total ?? row.ttfb)} | ${row.bucket} | ${row.path}${row.query} |`
  const api = data.rows.filter((item) => item.api)
  return [
    "# Frontend Load Audit",
    "",
    `- result: ${data.pass ? "pass" : "fail"}`,
    `- url: ${data.meta.url}`,
    `- api requests: ${api.length}`,
    `- total requests: ${data.rows.length}`,
    `- generated_at: ${data.meta.generated_at}`,
    "",
    "## Main Flow",
    "",
    "| check | result | note |",
    "| --- | --- | --- |",
    ...data.checks.map((item) => `| ${item.key} | ${item.ok ? "ok" : "fail"} | ${item.note} |`),
    "",
    "## Data Coverage",
    "",
    "| key | required | status | count | label |",
    "| --- | --- | --- | ---: | --- |",
    ...data.coverage.map((item) => `| ${item.key} | ${item.required ? "yes" : "no"} | ${item.status} | ${item.count} | ${item.label} |`),
    "",
    "## Request Summary",
    "",
    "| bucket | count | errors | avg_ms | p95_ms | max_ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...data.summary.map(
      (item) => `| ${item.bucket} | ${item.count} | ${item.errors} | ${item.avg_ms} | ${item.p95_ms} | ${item.max_ms} |`,
    ),
    "",
    "## Duplicate API Requests",
    "",
    data.dupes.length === 0 ? "No duplicate API requests." : "| count | max_ms | bucket | key |",
    data.dupes.length === 0 ? "" : "| ---: | ---: | --- | --- |",
    ...data.dupes.map((item) => `| ${item.count} | ${item.max_ms} | ${item.bucket} | ${item.key} |`),
    "",
    "## Endpoint Fan-Out",
    "",
    data.fanout.length === 0 ? "No endpoint fan-out above threshold." : "| count | total_ms | max_ms | bucket | shape |",
    data.fanout.length === 0 ? "" : "| ---: | ---: | ---: | --- | --- |",
    ...data.fanout.map((item) => `| ${item.count} | ${item.total_ms} | ${item.max_ms} | ${item.bucket} | ${item.key} |`),
    "",
    "## Slow Requests",
    "",
    data.slow.length === 0 ? "No slow requests above thresholds." : "| id | method | status | ms | bucket | path |",
    data.slow.length === 0 ? "" : "| ---: | --- | ---: | ---: | --- | --- |",
    ...data.slow.map(rowline),
    "",
    "## API Requests",
    "",
    "| id | method | status | ms | bucket | path |",
    "| ---: | --- | ---: | ---: | --- | --- |",
    ...api.map(rowline),
    "",
    "## Optimization Notes",
    "",
    ...data.advice.map((item) => `- ${item}`),
    "",
  ].join("\n")
}

function report(input: { rows: Row[]; checks: Check[]; url: string; console: string[]; pages: string[] }) {
  const slow = input.rows
    .filter((item) => {
      const total = item.total ?? item.ttfb ?? 0
      if (item.api) return total >= Number(process.env.OPENCODE_E2E_AUDIT_SLOW_API_MS ?? 700)
      return total >= Number(process.env.OPENCODE_E2E_AUDIT_SLOW_RESOURCE_MS ?? 1500)
    })
    .sort((a, b) => (b.total ?? b.ttfb ?? 0) - (a.total ?? a.ttfb ?? 0))
  const summary = bucket(input.rows)
  const duplicates = dupes(input.rows)
  const fans = fanout(input.rows)
  const covered = coverage(input.rows)
  const missing = covered.filter((item) => item.required && item.status !== "ok")
  const failed = input.rows.filter((item) => item.fail || (item.status ?? 0) >= 400)
  const max = Number(process.env.OPENCODE_E2E_AUDIT_FAIL_FANOUT_OVER ?? 0)
  const repeated =
    process.env.OPENCODE_E2E_AUDIT_FAIL_DUPES === "1"
      ? duplicates.map((item) => `duplicate request: ${item.count}x ${item.key}`)
      : []
  const wide = max > 0 ? fans.filter((item) => item.count > max).map((item) => `fan-out request: ${item.count}x ${item.key}`) : []
  const fail = [
    ...input.checks.filter((item) => !item.ok).map((item) => `main flow: ${item.key}`),
    ...missing.map((item) => `missing data: ${item.key}`),
    ...failed.map((item) => `request failed: ${item.method} ${item.path} ${item.status ?? item.fail}`),
    ...repeated,
    ...wide,
    ...input.pages.map((item) => `page error: ${item}`),
  ]

  return {
    pass: fail.length === 0,
    fail,
    meta: {
      url: input.url,
      generated_at: new Date().toISOString(),
      slow_api_ms: Number(process.env.OPENCODE_E2E_AUDIT_SLOW_API_MS ?? 700),
      slow_resource_ms: Number(process.env.OPENCODE_E2E_AUDIT_SLOW_RESOURCE_MS ?? 1500),
    },
    checks: input.checks,
    console: input.console,
    page_errors: input.pages,
    coverage: covered,
    summary,
    dupes: duplicates,
    fanout: fans,
    slow,
    advice: advice({ dupes: duplicates, fanout: fans, slow, summary }),
    rows: input.rows.sort((a, b) => a.id - b.id),
  }
}

function audit(page: Page) {
  const api = new URL(serverUrl)
  const rows: Row[] = []
  const reqs = new Map<Request, Row>()
  const active = new Set<number>()
  const console: string[] = []
  const pages: string[] = []
  let seq = 0
  let last = performance.now()

  const touch = () => {
    last = performance.now()
  }

  const onrequest = (req: Request) => {
    const item = row(++seq, req, api)
    rows.push(item)
    reqs.set(req, item)
    if (!item.stream) active.add(item.id)
    touch()
  }

  const onresponse = (res: Response) => {
    const item = reqs.get(res.request())
    if (!item) return
    item.status = res.status()
    item.ttfb = performance.now() - item.start
    touch()
  }

  const onfinished = (req: Request) => {
    const item = reqs.get(req)
    if (!item) return
    item.total = performance.now() - item.start
    active.delete(item.id)
    touch()
  }

  const onfailed = (req: Request) => {
    const item = reqs.get(req)
    if (!item) return
    item.fail = req.failure()?.errorText ?? "request failed"
    item.total = performance.now() - item.start
    active.delete(item.id)
    touch()
  }

  const onconsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return
    console.push(msg.text())
  }

  const onpage = (err: Error) => {
    pages.push(err.message)
  }

  page.on("request", onrequest)
  page.on("response", onresponse)
  page.on("requestfinished", onfinished)
  page.on("requestfailed", onfailed)
  page.on("console", onconsole)
  page.on("pageerror", onpage)

  return {
    rows,
    console,
    pages,
    quiet() {
      return active.size === 0 && performance.now() - last >= Number(process.env.OPENCODE_E2E_AUDIT_IDLE_MS ?? 800)
    },
    stop() {
      page.off("request", onrequest)
      page.off("response", onresponse)
      page.off("requestfinished", onfinished)
      page.off("requestfailed", onfailed)
      page.off("console", onconsole)
      page.off("pageerror", onpage)
    },
  }
}

async function save(data: ReturnType<typeof report>) {
  const dir = process.env.OPENCODE_E2E_AUDIT_DIR ?? path.join(process.cwd(), "e2e", "test-results", "load-audit")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "latest.json"), JSON.stringify(data, null, 2))
  await fs.writeFile(path.join(dir, "latest.md"), markdown(data))
  return dir
}

test("audits first session load requests", async ({ page, sdk, directory }) => {
  const dir = process.env.OPENCODE_E2E_AUDIT_DIRECTORY ?? directory
  const client = dir === directory ? sdk : createSdk(dir)
  const title = `load audit ${Date.now()}`

  await withSession(client, title, async (created) => {
    const probe = audit(page)
    await seedProjects(page, { directory: dir })
    await page.goto(sessionPath(dir, created.id))

    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.locator(promptSelector)).toBeEditable()
    await expect(page.locator(sessionItemSelector(created.id))).toBeVisible()
    await expect.poll(() => coverage(probe.rows).filter((item) => item.required && item.status !== "ok").length, {
      timeout: Number(process.env.OPENCODE_E2E_AUDIT_COVERAGE_MS ?? 20_000),
    }).toBe(0)
    await expect.poll(() => probe.quiet(), {
      timeout: Number(process.env.OPENCODE_E2E_AUDIT_TIMEOUT_MS ?? 30_000),
    }).toBe(true)

    const checks: Check[] = [
      { key: "prompt-visible", ok: await page.locator(promptSelector).isVisible(), note: "session prompt rendered" },
      { key: "prompt-editable", ok: await page.locator(promptSelector).isEditable(), note: "prompt accepts input" },
      { key: "session-route", ok: page.url().includes(`/session/${created.id}`), note: page.url() },
      { key: "session-sidebar", ok: await page.locator(sessionItemSelector(created.id)).isVisible(), note: created.id },
    ]
    const data = report({ rows: probe.rows, checks, url: page.url(), console: probe.console, pages: probe.pages })
    const out = await save(data)
    probe.stop()

    expect(data.fail, `load audit report: ${path.join(out, "latest.md")}`).toEqual([])
  })
})
