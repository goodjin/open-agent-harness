import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@open-agent-harness/ui/tabs"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { TooltipKeybind } from "@open-agent-harness/ui/tooltip"
import { Mark } from "@open-agent-harness/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@open-agent-harness/ui/context/dialog"

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
import { graphRuns, type GraphRun } from "@/pages/session/session-graph"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { SessionStatus } from "@open-agent-harness/sdk/v2/client"

type WorkflowStatus = "ready" | "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled" | "error"

function status(input: unknown): Exclude<WorkflowStatus, "error"> | undefined {
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

function label(status: GraphRun["status"] | WorkflowStatus | undefined) {
  if (status === "completed") return "Completed"
  if (status === "running") return "Running"
  if (status === "ready") return "Ready"
  if (status === "failed") return "Failed"
  if (status === "skipped") return "Skipped"
  if (status === "cancelled") return "Cancelled"
  if (status === "blocked") return "Blocked"
  return "Pending"
}

function tone(status: GraphRun["status"] | WorkflowStatus | undefined) {
  if (status === "completed") return "text-icon-success-base"
  if (status === "failed" || status === "blocked") return "text-text-danger-base"
  if (status === "running") return "text-text-interactive-base"
  if (status === "ready") return "text-icon-warning-base"
  if (status === "skipped" || status === "cancelled") return "text-text-muted"
  return "text-text-weak"
}

function sessionStatus(input: SessionStatus | undefined): WorkflowStatus | undefined {
  if (!input || input.type === "idle") return
  if (input.type === "error") return "failed"
  return "running"
}

function GraphPanel(props: {
  run: GraphRun
  runs: GraphRun[]
  select: (runID: string) => void
  status: (sessionID: string | undefined) => SessionStatus | undefined
}) {
  const active = (input: GraphRun["status"] | WorkflowStatus | undefined) => input === "running"
  const badge = (input: GraphRun["status"] | WorkflowStatus | undefined) => (
    <span>
      {label(input)}
      <Show when={active(input)}>
        <span class="inline-flex w-4 justify-start">
          <span class="animate-pulse">...</span>
        </span>
      </Show>
    </span>
  )
  const stateFor = (run: GraphRun): GraphRun["status"] | WorkflowStatus => {
    const states = run.nodes.flatMap((node) => {
      const value = sessionStatus(props.status(node.sessionID))
      return value ? [value] : []
    })
    if (states.includes("running")) return "running"
    if (states.includes("failed")) return "failed"
    return run.status
  }
  const state = (node: GraphRun["nodes"][number]): WorkflowStatus => {
    const active = sessionStatus(props.status(node.sessionID))
    if (active) return active === "failed" ? "failed" : "running"
    return status(node.status) ?? "pending"
  }
  const groups = createMemo(() =>
    (["running", "ready", "pending", "completed", "failed", "skipped", "cancelled"] as const)
      .map((id) => ({
        id,
        items: props.run.nodes.filter((node) => state(node) === id),
      }))
      .filter((item) => item.items.length > 0),
  )
  const count = (id: WorkflowStatus) => groups().find((item) => item.id === id)?.items.length ?? 0
  const total = createMemo(() => Math.max(props.run.total, props.run.nodes.length))

  return (
    <div class="h-full overflow-auto bg-background-stronger px-4 py-4">
      <div class="flex flex-col gap-4 pb-10">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-13-medium text-text-base truncate">{props.run.title}</div>
            <div class="mt-1 text-11-regular text-text-weak truncate">{props.run.id}</div>
            <div class="mt-1 text-11-regular text-text-weak truncate">source: {props.run.source}</div>
          </div>
          <div class={`text-11-medium shrink-0 ${tone(stateFor(props.run))}`}>{badge(stateFor(props.run))}</div>
        </div>

        <Show when={props.runs.length > 1}>
          <div class="flex flex-col gap-1.5">
            <div class="text-11-medium uppercase text-text-weak">Runs</div>
            <div class="flex flex-col gap-1">
              <For each={[...props.runs].reverse()}>
                {(run) => (
                  <button
                    type="button"
                    class="w-full border px-3 py-2 text-left"
                    classList={{
                      "border-border-strong bg-background-base": run.id === props.run.id,
                      "border-border-weaker-base bg-background-stronger": run.id !== props.run.id,
                    }}
                    onClick={() => props.select(run.id)}
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <div class="truncate text-12-medium text-text-base">{run.title}</div>
                        <div class="mt-0.5 truncate text-11-regular text-text-weak">{run.source}</div>
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
            <div class="mt-1 text-14-medium text-icon-success-base">{props.run.completed || count("completed")}</div>
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

        <Show when={props.run.pause || props.run.error}>
          <div class="border border-border-weaker-base px-3 py-2 text-12-regular text-text-muted">
            <Show when={props.run.pause}>{(pause) => <div>{pause().reason ?? pause().type}</div>}</Show>
            <Show when={props.run.error}>{(err) => <div>{err()}</div>}</Show>
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
                  {(node) => {
                    const deps = createMemo(() => node.deps)
                    const after = createMemo(() => node.after)
                    const phase = createMemo(() => state(node))
                    const index = createMemo(() => props.run.nodes.findIndex((item) => item.id === node.id) + 1)
                    return (
                      <details class="group border border-border-weaker-base bg-background-base">
                        <summary class="cursor-pointer list-none px-3 py-2">
                          <div class="flex items-center gap-3">
                            <div class={`w-6 shrink-0 text-11-medium ${tone(phase())}`}>{index()}</div>
                            <div class="min-w-0 flex-1">
                              <div class="flex min-w-0 items-center gap-2">
                                <div class="truncate text-12-medium text-text-base">{node.title}</div>
                                <div class="shrink-0 text-11-regular text-text-weak">{node.type}</div>
                              </div>
                              <div class="mt-0.5 truncate text-11-regular text-text-weak">
                                {node.executor} · attempts {node.attempt ?? 0}
                              </div>
                            </div>
                            <div class={`shrink-0 text-11-medium ${tone(phase())}`}>{badge(phase())}</div>
                          </div>
                        </summary>
                        <div class="border-t border-border-weaker-base px-3 py-3 text-12-regular text-text-muted">
                          <div class="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1">
                            <div class="text-text-weak">Executor</div>
                            <div class="min-w-0 break-all">{node.executor}</div>
                            <Show when={deps().length > 0}>
                              <div class="text-text-weak">Depends on</div>
                              <div class="min-w-0 break-words">{deps().join(", ")}</div>
                            </Show>
                            <Show when={after().length > 0}>
                              <div class="text-text-weak">Downstream</div>
                              <div class="min-w-0 break-words">{after().join(", ")}</div>
                            </Show>
                            <Show when={node.sessionID}>
                              {(id) => (
                                <>
                                  <div class="text-text-weak">Session</div>
                                  <div class="min-w-0 break-all">{id()}</div>
                                </>
                              )}
                            </Show>
                          </div>
                          <Show when={node.output || node.error}>
                            <div class="mt-3">
                              <div class="mb-1 text-11-medium text-text-weak">{node.error ? "Error" : "Output"}</div>
                              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-11-regular text-text-muted">
                                {node.error ?? node.output}
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
          <summary class="cursor-pointer list-none px-3 py-2 text-12-medium text-text-base">Metadata</summary>
          <pre class="max-h-80 overflow-auto border-t border-border-weaker-base px-3 py-3 whitespace-pre-wrap break-words font-mono text-11-regular text-text-muted">
            {JSON.stringify({ ...props.run.metadata, variables: props.run.variables }, null, 2)}
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
  const runs = createMemo(() => graphRuns(info()?.dsl_context))
  const [selected, setSelected] = createSignal<string>()
  createEffect(() => {
    const all = runs()
    if (all.length === 0) {
      setSelected(undefined)
      return
    }
    const current = selected()
    if (current && all.some((run) => run.id === current)) return
    setSelected(all[all.length - 1]?.id)
  })
  const run = createMemo(() => runs().find((item) => item.id === selected()) ?? runs()[runs().length - 1])
  const ready = createMemo(() => runs().length > 0 || local.agent.current()?.runner === "protocol")
  const graphTab = createMemo(() => isDesktop() && ready())
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
    graph: graphTab,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const select = (value: string) => {
    if (value === "review" || value === "logs" || value === "graph") {
      tabs().setActive(value)
      return
    }
    if (value === "workflow" || value === "protocol") {
      tabs().setActive("graph")
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
                      <Show when={graphTab()}>
                        <Tabs.Trigger value="graph">
                          <div class="flex items-center gap-1.5">
                            <div>Graph</div>
                            <Show when={run()}>
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

                  <Show when={graphTab()}>
                    <Tabs.Content value="graph" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "graph"}>
                        <Show when={run()} fallback={empty("No graph runs yet")}>
                          {(item) => (
                            <GraphPanel
                              run={item()}
                              runs={runs()}
                              select={setSelected}
                              status={(sessionID) => (sessionID ? sync.data.session_status[sessionID] : undefined)}
                            />
                          )}
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
