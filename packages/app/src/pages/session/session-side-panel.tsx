import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

type WorkflowNode = {
  step: string
  status?: WorkflowStatus
  agent?: string
  sessionID?: string
  path?: string
  attempt?: number
  output?: string
  error?: string
  depends_on?: string[]
  time: {
    started: number
    updated: number
    completed?: number
  }
}

type WorkflowStep = {
  id: string
  description?: string
  type: string
  agent?: string
  prompt?: string
  mutates?: boolean
  wait?: string
  depends_on?: string[]
  next?: unknown
  verification?: unknown
}

type WorkflowStatus = "ready" | "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled" | "error"

type WorkflowRun = {
  runID: string
  workflowID: string
  workflowName: string
  status: "active" | "completed" | "waiting_user" | "waiting_permission" | "aborted" | "error" | "failed" | "cancelled"
  current: string
  step: number
  total: number
  variables?: Record<string, unknown>
  attempts?: Record<string, number>
  completed?: string[]
  ready?: string[]
  running?: string[]
  failed?: string[]
  skipped?: string[]
  cancelled?: string[]
  statuses?: Record<string, WorkflowStatus>
  steps?: WorkflowStep[]
  nodes?: Record<string, WorkflowNode> | WorkflowStep[]
  pause?: {
    type: string
    step: string
    reason?: string
  }
  error?: string
  checkpoint?: string
  time: {
    started: number
    updated: number
    completed?: number
  }
}

type ProtocolAction = {
  id: string
  title: string
  operation: string
  status: "completed" | "blocked" | "failed" | "running" | "pending" | "skipped"
  summary?: string
  error?: string
  executor?: {
    type?: string
    target?: string
    capabilities?: string[]
  }
  tool_call_ids?: string[]
  duration_ms?: number
  time?: {
    started?: number
    completed?: number
  }
}

type ProtocolRun = {
  runID: string
  title: string
  status: "completed" | "blocked" | "failed" | "running" | "pending"
  total: number
  completed: number
  actions: ProtocolAction[]
  metrics?: {
    internal_tool_calls?: number
    direct_model_tool_calls?: number
    model_visible_bytes?: number
    raw_output_bytes?: number
    duration_ms?: number
  }
  time?: {
    started?: number
    completed?: number
  }
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function workflow(input: unknown): WorkflowRun | undefined {
  if (!record(input)) return
  const data = input.workflow
  if (!record(data)) return
  if (typeof data.runID !== "string") return
  if (typeof data.workflowID !== "string") return
  if (typeof data.workflowName !== "string") return
  if (typeof data.status !== "string") return
  if (typeof data.current !== "string") return
  if (typeof data.total !== "number") return
  return data as WorkflowRun
}

function workflows(input: unknown): WorkflowRun[] {
  if (!record(input)) return []
  const runs = Array.isArray(input.workflows) ? input.workflows : []
  const current = workflow(input)
  return [...runs, current]
    .filter((item): item is WorkflowRun => {
      if (!record(item)) return false
      if (!record(item.time)) return false
      return (
        typeof item.runID === "string" &&
        typeof item.workflowID === "string" &&
        typeof item.workflowName === "string" &&
        typeof item.status === "string" &&
        typeof item.current === "string" &&
        typeof item.total === "number" &&
        typeof item.time.started === "number"
      )
    })
    .filter((item, index, all) => all.findIndex((run) => run.runID === item.runID) === index)
    .sort((a, b) => a.time.started - b.time.started)
}

function protocols(input: unknown): ProtocolRun[] {
  if (!record(input)) return []
  const data = input.protocol
  if (!record(data)) return []
  const runs = Array.isArray(data.runs) ? data.runs : []
  return runs
    .filter((item): item is ProtocolRun => {
      if (!record(item)) return false
      return (
        typeof item.runID === "string" &&
        typeof item.title === "string" &&
        typeof item.status === "string" &&
        typeof item.total === "number" &&
        typeof item.completed === "number" &&
        Array.isArray(item.actions)
      )
    })
    .sort((a, b) => a.runID.localeCompare(b.runID))
}

function array(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string")
}

function status(input: unknown): WorkflowStatus | undefined {
  if (input === "error") return "failed"
  if (
    input === "ready" ||
    input === "pending" ||
    input === "running" ||
    input === "completed" ||
    input === "failed" ||
    input === "skipped" ||
    input === "cancelled"
  )
    return input
}

function label(status: WorkflowRun["status"] | WorkflowStatus | undefined) {
  if (status === "completed") return "Completed"
  if (status === "running" || status === "active") return "Running"
  if (status === "ready") return "Ready"
  if (status === "failed" || status === "error") return "Failed"
  if (status === "skipped") return "Skipped"
  if (status === "cancelled") return "Cancelled"
  if (status === "waiting_user") return "Waiting for user"
  if (status === "waiting_permission") return "Waiting for permission"
  if (status === "aborted") return "Aborted"
  return "Pending"
}

function tone(status: WorkflowRun["status"] | WorkflowStatus | undefined) {
  if (status === "completed") return "text-icon-success-base"
  if (status === "failed" || status === "error") return "text-text-danger-base"
  if (status === "running" || status === "active") return "text-text-interactive-base"
  if (status === "ready") return "text-icon-warning-base"
  if (status === "skipped" || status === "cancelled") return "text-text-muted"
  if (status === "waiting_user" || status === "waiting_permission") return "text-icon-warning-base"
  return "text-text-weak"
}

function value(input: unknown) {
  if (input === undefined) return ""
  if (typeof input === "string") return input
  return JSON.stringify(input, null, 2)
}

function next(input: unknown): string[] {
  if (typeof input === "string") return [input]
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === "string")
  if (!record(input)) return []
  return Object.values(input).flatMap(next)
}

function unique(input: string[]) {
  return [...new Set(input)]
}

function sessionStatus(input: SessionStatus | undefined): WorkflowRun["status"] | WorkflowStatus | undefined {
  if (!input || input.type === "idle") return
  if (input.type === "error") return "failed"
  return "running"
}

function ProtocolPanel(props: { run: ProtocolRun; runs: ProtocolRun[]; select: (runID: string) => void }) {
  const [active, setActive] = createSignal<string>()
  const action = createMemo(() => props.run.actions.find((item) => item.id === active()) ?? props.run.actions[0])
  const language = useLanguage()
  const date = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "medium" }))
  const stamp = (input: number | undefined) => (typeof input === "number" ? date().format(new Date(input)) : "-")
  createEffect(() => {
    const item = action()
    if (item) setActive(item.id)
  })
  const statusTone = (input: ProtocolAction["status"] | ProtocolRun["status"]) => {
    if (input === "completed") return "text-icon-success-base"
    if (input === "failed" || input === "blocked") return "text-text-danger-base"
    if (input === "running") return "text-text-interactive-base"
    return "text-text-weak"
  }
  return (
    <div class="h-full overflow-auto bg-background-stronger px-4 py-4">
      <div class="flex flex-col gap-4 pb-10">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="truncate text-13-medium text-text-base">{props.run.title}</div>
            <div class="mt-1 truncate text-11-regular text-text-weak">{props.run.runID}</div>
            <div class="mt-1 truncate text-11-regular text-text-weak">{stamp(props.run.time?.started)}</div>
          </div>
          <div class={`shrink-0 text-11-medium ${statusTone(props.run.status)}`}>{props.run.status}</div>
        </div>
        <div class="grid grid-cols-4 gap-2">
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Actions</div>
            <div class="mt-1 text-14-medium text-text-base">{props.run.total}</div>
          </div>
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Done</div>
            <div class="mt-1 text-14-medium text-icon-success-base">{props.run.completed}</div>
          </div>
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Tools</div>
            <div class="mt-1 text-14-medium text-text-base">{props.run.metrics?.internal_tool_calls ?? 0}</div>
          </div>
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Bytes</div>
            <div class="mt-1 text-14-medium text-text-base">{props.run.metrics?.model_visible_bytes ?? 0}</div>
          </div>
        </div>
        <Show when={props.runs.length > 1}>
          <div class="flex flex-col gap-1">
            <For each={props.runs}>
              {(run) => (
                <button
                  type="button"
                  class="border px-3 py-2 text-left text-12-regular text-text-base"
                  classList={{
                    "border-border-strong bg-background-base": run.runID === props.run.runID,
                    "border-border-weaker-base bg-background-stronger": run.runID !== props.run.runID,
                  }}
                  onClick={() => props.select(run.runID)}
                >
                  <div class="truncate">{run.title}</div>
                  <div class={`mt-0.5 text-11-regular ${statusTone(run.status)}`}>{run.status}</div>
                  <div class="mt-0.5 truncate text-11-regular text-text-weak">{stamp(run.time?.started)}</div>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="h-px bg-border-strong" />
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-3">
          <div class="flex flex-col gap-1.5">
            <For each={props.run.actions}>
              {(item) => (
                <button
                  type="button"
                  class="border px-3 py-2 text-left"
                  classList={{
                    "border-border-strong bg-background-base": action()?.id === item.id,
                    "border-border-weaker-base bg-background-stronger": action()?.id !== item.id,
                  }}
                  onClick={() => setActive(item.id)}
                >
                  <div class="truncate text-12-medium text-text-base">{item.title}</div>
                  <div class={`mt-0.5 text-11-regular ${statusTone(item.status)}`}>{item.status}</div>
                  <div class="mt-0.5 truncate text-11-regular text-text-weak">{stamp(item.time?.started)}</div>
                </button>
              )}
            </For>
          </div>
          <Show when={action()}>
            {(item) => (
              <div class="border border-border-weaker-base bg-background-base px-3 py-3 text-12-regular text-text-muted">
                <div class="text-13-medium text-text-base">{item().title}</div>
                <div class="mt-2 grid grid-cols-[76px_1fr] gap-x-3 gap-y-1">
                  <div class="text-text-weak">Operation</div>
                  <div>{item().operation}</div>
                  <div class="text-text-weak">Executor</div>
                  <div>{item().executor?.type ?? "runtime"}:{item().executor?.target ?? "auto"}</div>
                  <div class="text-text-weak">Duration</div>
                  <div>{item().duration_ms ?? 0}ms</div>
                  <div class="text-text-weak">Started</div>
                  <div>{stamp(item().time?.started)}</div>
                  <div class="text-text-weak">Tool calls</div>
                  <div>{item().tool_call_ids?.join(", ") || "none"}</div>
                </div>
                <Show when={item().summary || item().error}>
                  <pre class="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-11-regular">
                    {item().error ?? item().summary}
                  </pre>
                </Show>
              </div>
            )}
          </Show>
        </div>
        <details class="border border-border-weaker-base bg-background-base">
          <summary class="cursor-pointer list-none px-3 py-2 text-12-medium text-text-base">Comparison</summary>
          <pre class="max-h-80 overflow-auto border-t border-border-weaker-base px-3 py-3 whitespace-pre-wrap break-words font-mono text-11-regular text-text-muted">
            {JSON.stringify(props.run.metrics ?? {}, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  )
}

function WorkflowPanel(props: {
  workflow: WorkflowRun
  workflows: WorkflowRun[]
  selectWorkflow: (runID: string) => void
  status: (sessionID: string | undefined) => SessionStatus | undefined
}) {
  const active = (input: WorkflowRun["status"] | WorkflowStatus | undefined) => input === "running" || input === "active"
  const badge = (input: WorkflowRun["status"] | WorkflowStatus | undefined) => (
    <span>
      {label(input)}
      <Show when={active(input)}>
        <span class="inline-flex w-4 justify-start">
          <span class="animate-pulse">...</span>
        </span>
      </Show>
    </span>
  )
  const steps = createMemo(() => {
    const nodes = Array.isArray(props.workflow.nodes) ? props.workflow.nodes : []
    const runs =
      record(props.workflow.nodes) && !Array.isArray(props.workflow.nodes)
        ? (props.workflow.nodes as Record<string, WorkflowNode>)
        : {}
    const step = (id: string): WorkflowStep => ({
      id,
      type: "task",
      agent: runs[id]?.agent ?? "auto",
      mutates: false,
      depends_on: runs[id]?.depends_on,
    })
    const list: WorkflowStep[] = props.workflow.steps?.length
      ? props.workflow.steps
      : nodes.length
        ? nodes
        : [
            ...array(props.workflow.completed),
            ...array(props.workflow.ready),
            ...array(props.workflow.running),
            ...array(props.workflow.failed),
            ...array(props.workflow.skipped),
            ...array(props.workflow.cancelled),
          ].map(step)
    const seen = new Set(list.map((step) => step.id))
    const extra = unique([...Object.keys(runs), ...Object.keys(props.workflow.statuses ?? {})]).filter(
      (id) => !seen.has(id),
    )
    const all = [...list, ...extra.map(step)]
    if (!props.workflow.current || all.some((item) => item.id === props.workflow.current)) return all
    return [...all, step(props.workflow.current)]
  })

  const runs = createMemo(() =>
    record(props.workflow.nodes) && !Array.isArray(props.workflow.nodes)
      ? (props.workflow.nodes as Record<string, WorkflowNode>)
      : {},
  )
  const stateFor = (run: WorkflowRun): WorkflowRun["status"] | WorkflowStatus => {
    const nodes = record(run.nodes) && !Array.isArray(run.nodes) ? (run.nodes as Record<string, WorkflowNode>) : {}
    const states = Object.values(nodes).flatMap((node) => {
      const value = sessionStatus(props.status(node.sessionID))
      return value ? [value] : []
    })
    if (states.includes("running")) return "active"
    if (states.includes("failed")) return "error"
    return run.status
  }
  const edges = createMemo(() => {
    const out = new Map<string, string[]>()
    steps().forEach((step) => {
      const deps = unique([...array(step.depends_on), ...array(runs()[step.id]?.depends_on)])
      deps.forEach((id) => out.set(id, unique([...(out.get(id) ?? []), step.id])))
      next(step.next).forEach((id) => out.set(step.id, unique([...(out.get(step.id) ?? []), id])))
    })
    return out
  })
  const state = (id: string, step?: WorkflowStep): WorkflowStatus => {
    const run = runs()[id]
    const active = sessionStatus(props.status(run?.sessionID))
    if (active) return active === "failed" ? "failed" : "running"
    const phase = status(props.workflow.statuses?.[id])
    if (phase) return phase
    const value = status(run?.status)
    if (value) return value
    if (array(props.workflow.completed).includes(id)) return "completed"
    if (array(props.workflow.running).includes(id)) return "running"
    if (array(props.workflow.ready).includes(id)) return "ready"
    if (array(props.workflow.failed).includes(id)) return "failed"
    if (array(props.workflow.skipped).includes(id)) return "skipped"
    if (array(props.workflow.cancelled).includes(id)) return "cancelled"
    if (props.workflow.current === id && props.workflow.status === "active") return "running"
    if (step && [...array(step.depends_on), ...array(run?.depends_on)].length) return "pending"
    return "pending"
  }
  const groups = createMemo(() =>
    (["running", "ready", "pending", "completed", "failed", "skipped", "cancelled"] as const)
      .map((id) => ({
        id,
        items: steps().filter((step) => state(step.id, step) === id),
      }))
      .filter((item) => item.items.length > 0),
  )
  const count = (id: WorkflowStatus) => groups().find((item) => item.id === id)?.items.length ?? 0
  const total = createMemo(() => Math.max(props.workflow.total, steps().length))

  return (
    <div class="h-full overflow-auto bg-background-stronger px-4 py-4">
      <div class="flex flex-col gap-4 pb-10">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-13-medium text-text-base truncate">{props.workflow.workflowName}</div>
            <div class="mt-1 text-11-regular text-text-weak truncate">{props.workflow.workflowID}</div>
          </div>
          <div class={`text-11-medium shrink-0 ${tone(stateFor(props.workflow))}`}>{badge(stateFor(props.workflow))}</div>
        </div>

        <Show when={props.workflows.length > 1}>
          <div class="flex flex-col gap-1.5">
            <div class="text-11-medium uppercase text-text-weak">Runs</div>
            <div class="flex flex-col gap-1">
              <For each={[...props.workflows].reverse()}>
                {(run) => (
                  <button
                    type="button"
                    class="w-full border px-3 py-2 text-left"
                    classList={{
                      "border-border-strong bg-background-base": run.runID === props.workflow.runID,
                      "border-border-weaker-base bg-background-stronger": run.runID !== props.workflow.runID,
                    }}
                    onClick={() => props.selectWorkflow(run.runID)}
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <div class="truncate text-12-medium text-text-base">{run.workflowName}</div>
                        <div class="mt-0.5 truncate text-11-regular text-text-weak">{run.workflowID}</div>
                      </div>
                      <div class={`shrink-0 text-11-medium ${tone(stateFor(run))}`}>{badge(stateFor(run))}</div>
                    </div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="grid grid-cols-4 gap-2">
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Total</div>
            <div class="mt-1 text-14-medium text-text-base">{total()}</div>
          </div>
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Done</div>
            <div class="mt-1 text-14-medium text-icon-success-base">{count("completed")}</div>
          </div>
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Running</div>
            <div class="mt-1 text-14-medium text-text-interactive-base">{count("running")}</div>
          </div>
          <div class="border border-border-weaker-base px-2 py-2">
            <div class="text-11-regular text-text-weak">Failed</div>
            <div class="mt-1 text-14-medium text-text-danger-base">{count("failed")}</div>
          </div>
        </div>

        <Show when={props.workflow.pause || props.workflow.error}>
          <div class="border border-border-weaker-base px-3 py-2 text-12-regular text-text-muted">
            <Show when={props.workflow.pause}>{(pause) => <div>{pause().reason ?? pause().type}</div>}</Show>
            <Show when={props.workflow.error}>{(err) => <div>{err()}</div>}</Show>
          </div>
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-11-medium uppercase text-text-weak">Nodes</div>
          <For each={groups()}>
            {(group) => (
              <div class="flex flex-col gap-1.5">
                <div class={`text-11-medium uppercase ${tone(group.id)}`}>
                  {label(group.id)} · {group.items.length}
                </div>
                <For each={group.items}>
                  {(step) => {
                    const node = createMemo(() => runs()[step.id])
                    const deps = createMemo(() => unique([...array(step.depends_on), ...array(node()?.depends_on)]))
                    const after = createMemo(() => edges().get(step.id) ?? [])
                    const phase = createMemo(() => state(step.id, step))
                    const index = createMemo(() => steps().findIndex((item) => item.id === step.id) + 1)
                    return (
                      <details class="group border border-border-weaker-base bg-background-base">
                        <summary class="cursor-pointer list-none px-3 py-2">
                          <div class="flex items-center gap-3">
                            <div class={`w-6 shrink-0 text-11-medium ${tone(phase())}`}>{index()}</div>
                            <div class="min-w-0 flex-1">
                              <div class="flex min-w-0 items-center gap-2">
                                <div class="truncate text-12-medium text-text-base">{step.description ?? step.id}</div>
                                <div class="shrink-0 text-11-regular text-text-weak">{step.type}</div>
                              </div>
                              <div class="mt-0.5 truncate text-11-regular text-text-weak">
                                {node()?.agent ?? step.agent ?? "auto"} · attempts{" "}
                                {(props.workflow.attempts ?? {})[step.id] ?? node()?.attempt ?? 0}
                              </div>
                            </div>
                            <div class={`shrink-0 text-11-medium ${tone(phase())}`}>{badge(phase())}</div>
                          </div>
                        </summary>
                        <div class="border-t border-border-weaker-base px-3 py-3 text-12-regular text-text-muted">
                          <div class="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1">
                            <div class="text-text-weak">Agent</div>
                            <div class="min-w-0 break-all">{node()?.agent ?? step.agent ?? "auto"}</div>
                            <Show when={deps().length > 0}>
                              <div class="text-text-weak">Depends on</div>
                              <div class="min-w-0 break-words">{deps().join(", ")}</div>
                            </Show>
                            <Show when={after().length > 0}>
                              <div class="text-text-weak">Downstream</div>
                              <div class="min-w-0 break-words">{after().join(", ")}</div>
                            </Show>
                            <Show when={node()?.sessionID}>
                              {(id) => (
                                <>
                                  <div class="text-text-weak">Session</div>
                                  <div class="min-w-0 break-all">{id()}</div>
                                </>
                              )}
                            </Show>
                            <Show when={node()?.path}>
                              {(path) => (
                                <>
                                  <div class="text-text-weak">Node file</div>
                                  <div class="min-w-0 break-all">{path()}</div>
                                </>
                              )}
                            </Show>
                            <Show when={step.wait}>
                              {(wait) => (
                                <>
                                  <div class="text-text-weak">Wait</div>
                                  <div>{wait()}</div>
                                </>
                              )}
                            </Show>
                            <Show when={step.next !== undefined}>
                              <div class="text-text-weak">Next</div>
                              <pre class="min-w-0 whitespace-pre-wrap break-words font-mono text-11-regular">
                                {value(step.next)}
                              </pre>
                            </Show>
                          </div>
                          <Show when={step.prompt}>
                            {(prompt) => (
                              <div class="mt-3">
                                <div class="mb-1 text-11-medium text-text-weak">Prompt</div>
                                <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-11-regular text-text-muted">
                                  {prompt()}
                                </pre>
                              </div>
                            )}
                          </Show>
                          <Show when={node()?.output || node()?.error}>
                            <div class="mt-3">
                              <div class="mb-1 text-11-medium text-text-weak">{node()?.error ? "Error" : "Output"}</div>
                              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-11-regular text-text-muted">
                                {node()?.error ?? node()?.output}
                              </pre>
                            </div>
                          </Show>
                        </div>
                      </details>
                    )
                  }}
                </For>
              </div>
            )}
          </For>
        </div>

        <details class="border border-border-weaker-base bg-background-base">
          <summary class="cursor-pointer list-none px-3 py-2 text-12-medium text-text-base">Variables</summary>
          <pre class="max-h-80 overflow-auto border-t border-border-weaker-base px-3 py-3 whitespace-pre-wrap break-words font-mono text-11-regular text-text-muted">
            {JSON.stringify(props.workflow.variables ?? {}, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  )
}

export function SessionSidePanel(props: {
  reviewPanel: () => JSX.Element
  logPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
}) {
  const layout = useLayout()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const local = useLocal()
  const command = useCommand()
  const dialog = useDialog()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const reviewOpen = createMemo(() => isDesktop())
  const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const open = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const reviewTab = createMemo(() => isDesktop())
  const logTab = createMemo(() => isDesktop() && !!params.id)
  const fileTab = createMemo(() => isDesktop() && fileOpen())
  const panelWidth = createMemo(() => (open() ? `calc(100% - ${layout.session.width()}px)` : "0px"))

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const runs = createMemo(() => workflows(info()?.dsl_context))
  const protocolRuns = createMemo(() => protocols(info()?.dsl_context))
  const [selectedWorkflow, setSelectedWorkflow] = createSignal<string>()
  const [selectedProtocol, setSelectedProtocol] = createSignal<string>()
  createEffect(() => {
    const all = runs()
    if (all.length === 0) {
      setSelectedWorkflow(undefined)
      return
    }
    const selected = selectedWorkflow()
    if (selected && all.some((run) => run.runID === selected)) return
    setSelectedWorkflow(all[all.length - 1]?.runID)
  })
  const run = createMemo(() => runs().find((item) => item.runID === selectedWorkflow()) ?? runs()[runs().length - 1])
  createEffect(() => {
    const all = protocolRuns()
    if (all.length === 0) {
      setSelectedProtocol(undefined)
      return
    }
    const selected = selectedProtocol()
    if (selected && all.some((run) => run.runID === selected)) return
    setSelectedProtocol(all[all.length - 1]?.runID)
  })
  const protocolRun = createMemo(
    () => protocolRuns().find((item) => item.runID === selectedProtocol()) ?? protocolRuns()[protocolRuns().length - 1],
  )
  const workflowTab = createMemo(() => isDesktop() && runs().length > 0)
  const protocolReady = createMemo(() => protocolRuns().length > 0 || local.agent.current()?.runner === "protocol")
  const protocolTab = createMemo(() => isDesktop() && protocolReady())
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const reviewEmptyKey = createMemo(() => {
    if (sync.project && !sync.project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.noChanges"
  })

  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview,
    logs: logTab,
    files: fileTab,
    workflow: workflowTab,
    protocol: protocolTab,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const select = (value: string) => {
    if (value === "review" || value === "logs" || value === "workflow" || value === "protocol") {
      tabs().setActive(value)
      return
    }
    if (value === "changes" || value === "all") {
      layout.fileTree.open()
      layout.fileTree.setTab(value)
      tabs().setActive(value)
      return
    }
    openTab(value)
  }

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={select}>
                  <div class="sticky top-0 shrink-0 flex">
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={reviewTab()}>
                        <Tabs.Trigger value="review">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.review")}</div>
                            <Show when={hasReview()}>
                              <div>{reviewCount()}</div>
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={logTab()}>
                        <Tabs.Trigger value="logs">
                          <div>{language.t("session.tab.logs")}</div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={fileTab()}>
                        <Tabs.Trigger value="changes">
                          <div class="flex items-center gap-1.5">
                            <div>
                              {reviewCount()}{" "}
                              {language.t(
                                reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                              )}
                            </div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="all">
                          <div>{language.t("session.files.all")}</div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={workflowTab()}>
                        <Tabs.Trigger value="workflow">
                          <div class="flex items-center gap-1.5">
                            <div>Workflow</div>
                            <Show when={run()}>
                              {(item) => (
                                <div>
                                  {array(item().completed).length}/{item().total}
                                </div>
                              )}
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={protocolTab()}>
                        <Tabs.Trigger value="protocol">
                          <div class="flex items-center gap-1.5">
                            <div>Protocol</div>
                            <Show when={protocolRun()}>
                              {(item) => (
                                <div>
                                  {item().completed}/{item().total}
                                </div>
                              )}
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                      </SortableProvider>
                      <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                        <TooltipKeybind
                          title={language.t("command.file.open")}
                          keybind={command.keybind("file.open")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            onClick={() =>
                              dialog.show(() => <DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                            }
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </div>
                    </Tabs.List>
                  </div>

                  <Show when={reviewTab()}>
                    <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={logTab()}>
                    <Tabs.Content value="logs" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "logs"}>{props.logPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={workflowTab()}>
                    <Tabs.Content value="workflow" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "workflow" && run()}>
                        {(item) => (
                          <WorkflowPanel
                            workflow={item()}
                            workflows={runs()}
                            selectWorkflow={setSelectedWorkflow}
                            status={(sessionID) => (sessionID ? sync.data.session_status[sessionID] : undefined)}
                          />
                        )}
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={protocolTab()}>
                    <Tabs.Content value="protocol" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "protocol"}>
                        <Show when={protocolRun()} fallback={empty("No protocol runs yet")}>
                          {(item) => <ProtocolPanel run={item()} runs={protocolRuns()} select={setSelectedProtocol} />}
                        </Show>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "empty"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                          <Mark class="w-14 opacity-10" />
                          <div class="text-14-regular text-text-weak max-w-56">
                            {language.t("session.files.selectToOpen")}
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Tabs.Content>

                  <Show when={fileTab()}>
                    <Tabs.Content
                      id="file-tree-panel"
                      value="changes"
                      class="bg-background-stronger px-3 py-0 h-full overflow-hidden"
                    >
                      <Switch>
                        <Match when={hasReview()}>
                          <Show
                            when={diffsReady()}
                            fallback={
                              <div class="px-2 py-2 text-12-regular text-text-weak">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            }
                          >
                            <FileTree
                              path=""
                              class="pt-3"
                              allowed={diffFiles()}
                              kinds={kinds()}
                              draggable={false}
                              active={props.activeDiff}
                              onFileClick={(node) => props.focusReviewDiff(node.path)}
                            />
                          </Show>
                        </Match>
                        <Match when={true}>
                          {empty(
                            language.t(
                              sync.project && !sync.project.vcs ? "session.review.noChanges" : reviewEmptyKey(),
                            ),
                          )}
                        </Match>
                      </Switch>
                    </Tabs.Content>
                    <Tabs.Content value="all" class="bg-background-stronger px-3 py-0 h-full overflow-hidden">
                      <Switch>
                        <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                        <Match when={true}>
                          <FileTree
                            path=""
                            class="pt-3"
                            modified={diffFiles()}
                            kinds={kinds()}
                            onFileClick={(node) => openTab(file.tab(node.path))}
                          />
                        </Match>
                      </Switch>
                    </Tabs.Content>
                  </Show>

                  <Show when={contextOpen()}>
                    <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "context"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <SessionContextTab />
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={activeFileTab()} keyed>
                    {(tab) => <FileTabContent tab={tab} />}
                  </Show>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = file.pathFromTab(tab)
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>
        </div>
      </aside>
    </Show>
  )
}
