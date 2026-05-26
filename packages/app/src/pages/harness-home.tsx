import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { A, useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { createMemo, createResource, For, Show } from "solid-js"

type Run = {
  id: string
  status: string
  pending_decisions: number
  active_assignments: number
  updated_at: number
}

type Stat = {
  dir: string
  runs: number
  active: number
  decisions: number
  updated: number
}

function enc(input: string) {
  return /[^\x00-\x7F]/.test(input) ? encodeURIComponent(input) : input
}

function fmt(input: number) {
  if (!input) return "暂无 Run"
  return DateTime.fromMillis(input).toRelative() ?? "刚刚"
}

function cls(input: number) {
  if (input > 0) return "text-text-interactive-base"
  return "text-text-muted"
}

export default function HarnessHome() {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const layout = useLayout()
  const server = useServer()
  const nav = useNavigate()

  const projects = createMemo(() =>
    sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
  )

  async function runs(dir: string) {
    const url = new URL("/harness/runs", sdk.url)
    url.searchParams.set("directory", dir)
    const res = await sdk.request(`${url.pathname}${url.search}`, {
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": enc(dir),
      },
    })
    if (!res.ok) return [] as Run[]
    return (await res.json()) as Run[]
  }

  const [stats, act] = createResource(projects, async (items) => {
    const list = await Promise.all(
      items.map(async (project): Promise<Stat> => {
        const data = await runs(project.worktree)
        return {
          dir: project.worktree,
          runs: data.length,
          active: data.filter((item) => ["running", "reviewing", "verifying", "reworking", "blocked"].includes(item.status)).length,
          decisions: data.reduce((sum, item) => sum + item.pending_decisions, 0),
          updated: data.reduce((max, item) => Math.max(max, item.updated_at), 0),
        }
      }),
    )
    return new Map(list.map((item) => [item.dir, item]))
  })

  const total = createMemo(() => {
    const list = [...(stats()?.values() ?? [])]
    return {
      projects: projects().length,
      runs: list.reduce((sum, item) => sum + item.runs, 0),
      active: list.reduce((sum, item) => sum + item.active, 0),
      decisions: list.reduce((sum, item) => sum + item.decisions, 0),
    }
  })

  function open(dir: string) {
    layout.projects.open(dir)
    server.projects.touch(dir)
    nav(`/${base64Encode(dir)}/harness`)
  }

  return (
    <div class="min-h-dvh bg-background-base text-text-base">
      <main class="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <header class="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle pb-5">
          <div>
            <A href="/" class="text-12-regular text-text-muted hover:text-text-base">
              返回 OpenCode 首页
            </A>
            <h1 class="mt-3 text-28-bold text-text-strong">Harness 项目总览</h1>
            <p class="mt-2 max-w-2xl text-14-regular text-text-muted">选择一个项目进入多会话 Agent 治理控制台。</p>
          </div>
          <Button icon="reset" variant="ghost" onClick={() => void act.refetch()}>
            刷新统计
          </Button>
        </header>

        <section class="grid gap-3 md:grid-cols-4">
          <Metric label="项目" value={String(total().projects)} />
          <Metric label="Run" value={String(total().runs)} />
          <Metric label="活跃" value={String(total().active)} />
          <Metric label="待决策" value={String(total().decisions)} />
        </section>

        <section class="grid gap-3">
          <For each={projects()} fallback={<Empty />}>
            {(project) => {
              const stat = () => stats()?.get(project.worktree)
              return (
                <button
                  type="button"
                  class="grid gap-4 rounded-md border border-border-subtle bg-surface-panel p-4 text-left transition-colors hover:bg-surface-raised-base-hover md:grid-cols-[1fr_320px]"
                  onClick={() => open(project.worktree)}
                >
                  <div class="min-w-0">
                    <div class="flex items-center gap-3">
                      <div class="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-raised-base">
                        <Icon name="folder" size="small" />
                      </div>
                      <div class="min-w-0">
                        <h2 class="truncate text-15-bold text-text-strong">{project.name ?? getFilename(project.worktree)}</h2>
                        <p class="truncate text-12-regular text-text-muted">{project.worktree}</p>
                      </div>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 gap-2 text-right">
                    <Small label="Run" value={String(stat()?.runs ?? 0)} tone={cls(stat()?.runs ?? 0)} />
                    <Small label="活跃" value={String(stat()?.active ?? 0)} tone={cls(stat()?.active ?? 0)} />
                    <Small label="决策" value={String(stat()?.decisions ?? 0)} tone={cls(stat()?.decisions ?? 0)} />
                    <Small label="更新" value={fmt(stat()?.updated ?? 0)} tone="text-text-muted" />
                  </div>
                </button>
              )
            }}
          </For>
          <Show when={stats.loading}>
            <p class="text-13-regular text-text-muted">正在读取 Harness 统计...</p>
          </Show>
        </section>
      </main>
    </div>
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

function Small(props: { label: string; value: string; tone: string }) {
  return (
    <div class="min-w-0">
      <p class="text-11-regular text-text-muted">{props.label}</p>
      <p class={`mt-1 truncate text-13-medium ${props.tone}`}>{props.value}</p>
    </div>
  )
}

function Empty() {
  return (
    <div class="rounded-md border border-border-subtle bg-surface-panel p-8 text-center">
      <p class="text-14-medium text-text-strong">暂无项目</p>
      <p class="mt-1 text-12-regular text-text-muted">先在 OpenCode 首页打开一个项目。</p>
    </div>
  )
}
