import { useSDK } from "@/context/sdk"
import { A } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { JSX } from "solid-js"

type Status = "drafting" | "ready" | "running" | "paused" | "blocked" | "reviewing" | "verifying" | "reworking" | "completed" | "failed" | "aborted"

type Run = {
  id: string
  name: string
  status: Status
  goal: string
  mode: string
  automation: "manual" | "guided" | "auto"
  memory_scopes: string[]
  progress: { completed: number; total: number }
  active_assignments: number
  pending_decisions: number
  updated_at: number
}

type Gate = {
  id: string
  status: "pending" | "passed" | "failed" | "blocked"
  required: string[]
  evidence: string[]
  reason?: string
}

type Task = {
  id: string
  run_id: string
  title: string
  type: string
  status: string
  goal: string
  depends_on: string[]
  acceptance: string[]
  gates: Gate[]
  artifacts: string[]
}

type Decision = {
  id: string
  run_id: string
  task_id?: string
  level: string
  status: string
  question: string
  options: { id: string; label: string; tradeoff?: string }[]
  recommended?: string
  answer?: string
}

type Artifact = {
  id: string
  task_id?: string
  kind: string
  path: string
  summary?: string
}

type Event = {
  id: string
  type: string
  actor: string
  time: number
  summary?: string
}

type Memory = {
  id: string
  scope: string
  namespace: string
  kind: string
  status: string
  summary: string
  evidence: string[]
}

type Concept = {
  id: string
  kind: string
  scope: string
  namespace: string
  status: string
  version: number
  summary: string
  source?: string
  refs: string[]
  replaces: string[]
  replaced_by: string[]
  new_information?: string
  evidence: string[]
}

type Summary = {
  run: Run
  tasks: Task[]
  decisions: Decision[]
  artifacts: Artifact[]
  events: Event[]
}

type Graph = {
  nodes: { id: string; label: string; status: string; gates?: Gate[]; artifacts?: number; kind?: string }[]
  edges: { from: string; to: string; type?: string }[]
}

const tabs = ["总览", "任务", "决策", "记忆", "概念", "图谱", "审计"] as const
type Tab = (typeof tabs)[number]

function stamp(input: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(input)
}

function pct(run: Run) {
  if (run.progress.total === 0) return 0
  return Math.round((run.progress.completed / run.progress.total) * 100)
}

function cls(status: string) {
  if (["completed", "approved", "merged", "passed", "answered"].includes(status)) return "text-text-diff-add-base"
  if (["failed", "aborted", "cancelled", "review_rejected", "verify_failed"].includes(status)) return "text-text-danger-base"
  if (["running", "reviewing", "verifying"].includes(status)) return "text-text-interactive-base"
  if (["paused", "blocked", "pending"].includes(status)) return "text-icon-warning-base"
  return "text-text-base"
}

export default function Harness() {
  const sdk = useSDK()
  const [tab, setTab] = createSignal<Tab>("总览")
  const [run, setRun] = createSignal("")
  const [goal, setGoal] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal("")
  const [err, setErr] = createSignal("")

  async function raw(path: string, opts?: RequestInit) {
    const url = new URL(`/harness${path}`, sdk.url)
    url.searchParams.set("directory", sdk.directory)
    return sdk.request(`${url.pathname}${url.search}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    })
  }

  async function api<T>(path: string, opts?: RequestInit) {
    const res = await raw(path, opts)
    if (res.ok) return (await res.json()) as T
    throw new Error(await res.text())
  }

  const [runs, runact] = createResource(() => api<Run[]>("/runs"))
  const [summary, sumact] = createResource(run, (id) => (id ? api<Summary>(`/runs/${id}`) : undefined))
  const [graph, graphact] = createResource(run, (id) => (id ? api<Graph>(`/runs/${id}/graph`) : undefined))
  const [audit, auditact] = createResource(run, (id) => (id ? api<{ events: Event[]; gates: (Gate & { task_id: string })[] }>(`/runs/${id}/audit`) : undefined))
  const [rebuild] = createResource(run, (id) => (id ? api<{ source_events: number; projections: { name: string }[] }>(`/runs/${id}/projections/rebuild`) : undefined))
  const [memories] = createResource(query, (q) => api<Memory[]>(`/memory/query${q ? `?q=${encodeURIComponent(q)}` : ""}`))
  const [concepts, conact] = createResource(() => api<Concept[]>("/concepts"))
  const [conceptGraph] = createResource(() => api<Graph>("/concepts/graph"))

  createEffect(() => {
    if (run()) return
    const first = runs()?.[0]
    if (first) setRun(first.id)
  })

  const current = createMemo(() => summary()?.run ?? runs()?.find((item) => item.id === run()))

  async function refresh() {
    await Promise.all([runact.refetch(), sumact.refetch(), graphact.refetch(), auditact.refetch(), conact.refetch()])
  }

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    setErr("")
    try {
      await fn()
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy("")
    }
  }

  function post(path: string, body?: unknown) {
    return api<Run>(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" })
  }

  async function save(format: "json" | "markdown") {
    const id = run()
    if (!id) return
    await act(`export-${format}`, async () => {
      const res = await raw(`/runs/${id}/audit/export?format=${format}`)
      if (!res.ok) throw new Error(await res.text())
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement("a")
      a.href = url
      a.download = `harness-audit-${id}.${format === "json" ? "json" : "md"}`
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  return (
    <div class="h-full min-h-0 bg-background-base text-text-base">
      <div class="grid h-full min-h-0 grid-cols-[280px_1fr]">
        <aside class="min-h-0 border-r border-border-subtle bg-surface-panel p-4 flex flex-col gap-4">
          <A href="session" class="text-12-regular text-text-muted hover:text-text-base">
            返回会话
          </A>
          <div>
            <h1 class="text-18-bold text-text-strong">Harness Console</h1>
            <p class="text-12-regular text-text-muted mt-1 truncate">{sdk.directory}</p>
          </div>
          <form
            class="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const text = goal().trim()
              if (!text) return
              void act("create", async () => {
                const item = await api<Run>("/runs", { method: "POST", body: JSON.stringify({ goal: text, automation: "guided" }) })
                setGoal("")
                setRun(item.id)
              })
            }}
          >
            <textarea
              class="min-h-24 resize-none rounded-md border border-border-subtle bg-background-base p-3 text-13-regular text-text-base outline-none focus:border-border-strong"
              placeholder="输入一个大任务目标"
              value={goal()}
              onInput={(e) => setGoal(e.currentTarget.value)}
            />
            <button class="rounded-md bg-text-interactive-base px-3 py-2 text-13-medium text-background-base disabled:opacity-50" disabled={busy() === "create"}>
              创建 Run
            </button>
          </form>
          <div class="min-h-0 flex-1 overflow-auto flex flex-col gap-2">
            <For each={runs() ?? []}>
              {(item) => (
                <button
                  type="button"
                  class={`rounded-md border p-3 text-left transition-colors ${run() === item.id ? "border-border-strong bg-surface-raised-base" : "border-border-subtle hover:bg-surface-raised-base-hover"}`}
                  onClick={() => setRun(item.id)}
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-13-medium text-text-strong truncate">{item.name}</span>
                    <span class={`text-11-medium ${cls(item.status)}`}>{item.status}</span>
                  </div>
                  <div class="mt-2 h-1.5 rounded-full bg-surface-raised-base overflow-hidden">
                    <div class="h-full bg-accent" style={{ width: `${pct(item)}%` }} />
                  </div>
                  <p class="mt-2 text-11-regular text-text-muted">{stamp(item.updated_at)}</p>
                </button>
              )}
            </For>
          </div>
        </aside>
        <main class="min-h-0 overflow-auto">
          <Show when={current()} fallback={<Empty />}>
            {(item) => (
              <div class="mx-auto max-w-7xl p-6 flex flex-col gap-5">
                <header class="flex flex-wrap items-start justify-between gap-4">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <h2 class="text-24-bold text-text-strong">{item().name}</h2>
                      <span class={`text-12-medium ${cls(item().status)}`}>{item().status}</span>
                    </div>
                    <p class="mt-2 max-w-3xl text-14-regular text-text-base">{item().goal}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <button class="rounded-md border border-border-subtle px-3 py-2 text-12-medium hover:bg-surface-raised-base-hover" onClick={() => void act("pause", () => post(`/runs/${item().id}/pause`))}>
                      暂停
                    </button>
                    <button class="rounded-md border border-border-subtle px-3 py-2 text-12-medium hover:bg-surface-raised-base-hover" onClick={() => void act("resume", () => post(`/runs/${item().id}/resume`))}>
                      继续
                    </button>
                    <button class="rounded-md border border-icon-critical-base px-3 py-2 text-12-medium text-text-danger-base hover:bg-surface-raised-base-hover" onClick={() => void act("abort", () => post(`/runs/${item().id}/abort`))}>
                      终止
                    </button>
                  </div>
                </header>
                <Show when={err()}>
                  <p class="rounded-md border border-icon-critical-base bg-surface-panel p-3 text-12-regular text-text-danger-base">{err()}</p>
                </Show>
                <nav class="flex flex-wrap gap-2 border-b border-border-subtle pb-2">
                  <For each={tabs}>
                    {(item) => (
                      <button
                        type="button"
                        class={`rounded-md px-3 py-2 text-13-medium ${tab() === item ? "bg-surface-raised-base text-text-strong" : "text-text-muted hover:text-text-base hover:bg-surface-raised-base-hover"}`}
                        onClick={() => setTab(item)}
                      >
                        {item}
                      </button>
                    )}
                  </For>
                </nav>
                <Show when={tab() === "总览"}>
                  <Overview run={item()} summary={summary()} />
                </Show>
                <Show when={tab() === "任务"}>
                  <Tasks items={summary()?.tasks ?? []} busy={busy()} onRetry={(task) => act(`retry-${task.id}`, () => post(`/tasks/${task.id}/retry`, { run_id: item().id }))} onCancel={(task) => act(`cancel-${task.id}`, () => post(`/tasks/${task.id}/cancel`, { run_id: item().id }))} onVerify={(task) => act(`verify-${task.id}`, () => post(`/verifications/${task.id}/rerun`, { run_id: item().id }))} />
                </Show>
                <Show when={tab() === "决策"}>
                  <Decisions items={summary()?.decisions ?? []} onAnswer={(dec, answer) => act(`decision-${dec.id}`, () => post(`/decisions/${dec.id}/answer`, { run_id: item().id, answer }))} />
                </Show>
                <Show when={tab() === "记忆"}>
                  <MemoryView query={query()} items={memories() ?? []} onQuery={setQuery} />
                </Show>
                <Show when={tab() === "概念"}>
                  <Concepts items={concepts() ?? []} />
                </Show>
                <Show when={tab() === "图谱"}>
                  <Graphs run={graph()} concepts={conceptGraph()} />
                </Show>
                <Show when={tab() === "审计"}>
                  <AuditView
                    events={audit()?.events ?? summary()?.events ?? []}
                    gates={audit()?.gates ?? []}
                    artifacts={summary()?.artifacts ?? []}
                    rebuild={rebuild()}
                    onExport={save}
                  />
                </Show>
              </div>
            )}
          </Show>
        </main>
      </div>
    </div>
  )
}

function Empty() {
  return <div class="h-full flex items-center justify-center text-14-regular text-text-muted">创建一个 Run 后开始治理多会话任务。</div>
}

function Overview(props: { run: Run; summary?: Summary }) {
  const cards = () => [
    { label: "进度", value: `${props.run.progress.completed}/${props.run.progress.total}` },
    { label: "活跃分派", value: String(props.run.active_assignments) },
    { label: "待决策", value: String(props.run.pending_decisions) },
    { label: "自动化", value: props.run.automation },
  ]
  return (
    <section class="grid gap-4 lg:grid-cols-4">
      <For each={cards()}>{(item) => <Metric label={item.label} value={item.value} />}</For>
      <Panel title="当前上下文">
        <div class="flex flex-wrap gap-2">
          <For each={props.run.memory_scopes}>{(item) => <Badge>{item}</Badge>}</For>
        </div>
      </Panel>
      <Panel title="最近事件">
        <For each={(props.summary?.events ?? []).slice(-6).reverse()} fallback={<p class="text-13-regular text-text-muted">暂无事件</p>}>
          {(item) => (
            <div class="border-b border-border-subtle py-2 last:border-0">
              <div class="flex justify-between gap-3 text-12-medium">
                <span class="text-text-strong">{item.type}</span>
                <span class="text-text-muted">{stamp(item.time)}</span>
              </div>
              <p class="mt-1 text-12-regular text-text-muted">{item.summary ?? item.actor}</p>
            </div>
          )}
        </For>
      </Panel>
    </section>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded-md border border-border-subtle bg-surface-panel p-4">
      <p class="text-12-regular text-text-muted">{props.label}</p>
      <p class="mt-2 text-24-bold text-text-strong">{props.value}</p>
    </div>
  )
}

function Panel(props: { title: string; children?: JSX.Element }) {
  return (
    <div class="rounded-md border border-border-subtle bg-surface-panel p-4 lg:col-span-2">
      <h3 class="text-14-bold text-text-strong mb-3">{props.title}</h3>
      {props.children}
    </div>
  )
}

function Badge(props: { children?: JSX.Element }) {
  return <span class="rounded-md bg-surface-raised-base px-2 py-1 text-11-medium text-text-base">{props.children}</span>
}

function Tasks(props: { items: Task[]; busy: string; onRetry: (task: Task) => void; onCancel: (task: Task) => void; onVerify: (task: Task) => void }) {
  return (
    <div class="grid gap-3">
      <For each={props.items} fallback={<EmptyLine text="暂无任务" />}>
        {(item) => (
          <article class="rounded-md border border-border-subtle bg-surface-panel p-4">
            <div class="flex flex-wrap justify-between gap-3">
              <div>
                <h3 class="text-15-bold text-text-strong">{item.title}</h3>
                <p class="mt-1 text-13-regular text-text-base">{item.goal}</p>
              </div>
              <span class={`text-12-medium ${cls(item.status)}`}>{item.status}</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <For each={item.acceptance}>{(text) => <Badge>{text}</Badge>}</For>
            </div>
            <div class="mt-4 grid gap-2 md:grid-cols-2">
              <For each={item.gates}>{(gate) => <GateItem item={gate} />}</For>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <button class="rounded-md border border-border-subtle px-3 py-2 text-12-medium hover:bg-surface-raised-base-hover" onClick={() => props.onRetry(item)} disabled={props.busy === `retry-${item.id}`}>
                重试
              </button>
              <button class="rounded-md border border-border-subtle px-3 py-2 text-12-medium hover:bg-surface-raised-base-hover" onClick={() => props.onVerify(item)}>
                重跑验证
              </button>
              <button class="rounded-md border border-icon-critical-base px-3 py-2 text-12-medium text-text-danger-base hover:bg-surface-raised-base-hover" onClick={() => props.onCancel(item)}>
                取消
              </button>
            </div>
          </article>
        )}
      </For>
    </div>
  )
}

function GateItem(props: { item: Gate }) {
  return (
    <div class="rounded-md border border-border-subtle bg-background-base p-3">
      <div class="flex justify-between gap-2">
        <span class="text-12-medium text-text-strong">{props.item.id}</span>
        <span class={`text-12-medium ${cls(props.item.status)}`}>{props.item.status}</span>
      </div>
      <p class="mt-2 text-12-regular text-text-muted">{props.item.evidence.join(" · ") || props.item.required.join(" · ") || "等待证据"}</p>
    </div>
  )
}

function Decisions(props: { items: Decision[]; onAnswer: (dec: Decision, answer: string) => void }) {
  const [draft, setDraft] = createSignal<Record<string, string>>({})
  return (
    <div class="grid gap-3">
      <For each={props.items} fallback={<EmptyLine text="暂无待决策事项" />}>
        {(item) => (
          <article class="rounded-md border border-border-subtle bg-surface-panel p-4">
            <div class="flex flex-wrap justify-between gap-3">
              <h3 class="text-15-bold text-text-strong">{item.question}</h3>
              <span class={`text-12-medium ${cls(item.status)}`}>{item.level} · {item.status}</span>
            </div>
            <div class="mt-3 grid gap-2 md:grid-cols-2">
              <For each={item.options}>
                {(opt) => (
                  <button
                    class={`rounded-md border p-3 text-left ${item.recommended === opt.id ? "border-border-strong bg-surface-raised-base" : "border-border-subtle hover:bg-surface-raised-base-hover"}`}
                    onClick={() => props.onAnswer(item, opt.id)}
                  >
                    <span class="text-13-medium text-text-strong">{opt.label}</span>
                    <p class="mt-1 text-12-regular text-text-muted">{opt.tradeoff ?? opt.id}</p>
                  </button>
                )}
              </For>
            </div>
            <Show when={item.options.length === 0}>
              <div class="mt-3 flex gap-2">
                <input class="min-w-0 flex-1 rounded-md border border-border-subtle bg-background-base px-3 py-2 text-13-regular outline-none" value={draft()[item.id] ?? ""} onInput={(e) => setDraft({ ...draft(), [item.id]: e.currentTarget.value })} />
                <button class="rounded-md bg-text-interactive-base px-3 py-2 text-12-medium text-background-base" onClick={() => props.onAnswer(item, draft()[item.id] ?? "")}>
                  提交
                </button>
              </div>
            </Show>
          </article>
        )}
      </For>
    </div>
  )
}

function MemoryView(props: { query: string; items: Memory[]; onQuery: (value: string) => void }) {
  return (
    <section class="flex flex-col gap-3">
      <input class="rounded-md border border-border-subtle bg-background-base px-3 py-2 text-13-regular outline-none" placeholder="搜索项目、团队、全局记忆" value={props.query} onInput={(e) => props.onQuery(e.currentTarget.value)} />
      <div class="grid gap-3 md:grid-cols-2">
        <For each={props.items} fallback={<EmptyLine text="暂无记忆记录" />}>
          {(item) => (
            <article class="rounded-md border border-border-subtle bg-surface-panel p-4">
              <div class="flex flex-wrap gap-2">
                <Badge>{item.scope}</Badge>
                <Badge>{item.kind}</Badge>
                <Badge>{item.status}</Badge>
              </div>
              <p class="mt-3 text-13-regular text-text-base">{item.summary}</p>
              <p class="mt-2 text-12-regular text-text-muted">{item.namespace}</p>
            </article>
          )}
        </For>
      </div>
    </section>
  )
}

function Concepts(props: { items: Concept[] }) {
  return (
    <div class="grid gap-3 md:grid-cols-2">
      <For each={props.items} fallback={<EmptyLine text="暂无概念记录" />}>
        {(item) => (
          <article class="rounded-md border border-border-subtle bg-surface-panel p-4">
            <div class="flex flex-wrap justify-between gap-2">
              <h3 class="text-14-bold text-text-strong">{item.summary}</h3>
              <span class={`text-12-medium ${cls(item.status)}`}>v{item.version} · {item.status}</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <Badge>{item.scope}</Badge>
              <Badge>{item.kind}</Badge>
              <Badge>{item.namespace}</Badge>
            </div>
            <p class="mt-3 text-12-regular text-text-muted">{item.new_information ?? item.source ?? "无替换说明"}</p>
          </article>
        )}
      </For>
    </div>
  )
}

function Graphs(props: { run?: Graph; concepts?: Graph }) {
  return (
    <div class="grid gap-4 lg:grid-cols-2">
      <GraphPanel title="任务图" graph={props.run} />
      <GraphPanel title="概念替换图" graph={props.concepts} />
    </div>
  )
}

function GraphPanel(props: { title: string; graph?: Graph }) {
  return (
    <div class="rounded-md border border-border-subtle bg-surface-panel p-4">
      <h3 class="text-14-bold text-text-strong mb-3">{props.title}</h3>
      <div class="grid gap-2">
        <For each={props.graph?.nodes ?? []} fallback={<EmptyLine text="暂无节点" />}>
          {(item) => (
            <div class="rounded-md border border-border-subtle bg-background-base p-3">
              <div class="flex justify-between gap-3">
                <span class="text-13-medium text-text-strong truncate">{item.label}</span>
                <span class={`text-12-medium ${cls(item.status)}`}>{item.status}</span>
              </div>
              <p class="mt-1 text-11-regular text-text-muted">{item.id}</p>
            </div>
          )}
        </For>
      </div>
      <p class="mt-3 text-12-regular text-text-muted">{props.graph?.edges.length ?? 0} 条依赖或替换关系</p>
    </div>
  )
}

function AuditView(props: {
  events: Event[]
  gates: (Gate & { task_id: string })[]
  artifacts: Artifact[]
  rebuild?: { source_events: number; projections: { name: string }[] }
  onExport: (format: "json" | "markdown") => void
}) {
  return (
    <div class="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div class="rounded-md border border-border-subtle bg-surface-panel p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-14-bold text-text-strong">事件时间线</h3>
          <div class="flex gap-2">
            <button class="rounded-md border border-border-subtle px-3 py-2 text-12-medium hover:bg-surface-raised-base-hover" onClick={() => props.onExport("json")}>
              导出 JSON
            </button>
            <button class="rounded-md border border-border-subtle px-3 py-2 text-12-medium hover:bg-surface-raised-base-hover" onClick={() => props.onExport("markdown")}>
              导出 Markdown
            </button>
          </div>
        </div>
        <For each={props.events.slice().reverse()} fallback={<EmptyLine text="暂无事件" />}>
          {(item) => (
            <div class="border-b border-border-subtle py-3 last:border-0">
              <div class="flex flex-wrap justify-between gap-2">
                <span class="text-13-medium text-text-strong">{item.type}</span>
                <span class="text-12-regular text-text-muted">{stamp(item.time)}</span>
              </div>
              <p class="mt-1 text-12-regular text-text-muted">{item.summary ?? item.actor}</p>
            </div>
          )}
        </For>
      </div>
      <div class="flex flex-col gap-4">
        <Panel title="Projection 调试">
          <p class="text-12-regular text-text-muted">来源事件：{props.rebuild?.source_events ?? 0}</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <For each={props.rebuild?.projections ?? []}>{(item) => <Badge>{item.name}</Badge>}</For>
          </div>
        </Panel>
        <Panel title="门禁证据">
          <For each={props.gates} fallback={<EmptyLine text="暂无门禁" />}>
            {(item) => <GateItem item={item} />}
          </For>
        </Panel>
        <Panel title="产物">
          <For each={props.artifacts} fallback={<EmptyLine text="暂无产物" />}>
            {(item) => <p class="truncate py-1 text-12-regular text-text-base">{item.kind}: {item.path}</p>}
          </For>
        </Panel>
      </div>
    </div>
  )
}

function EmptyLine(props: { text: string }) {
  return <p class="text-13-regular text-text-muted">{props.text}</p>
}
