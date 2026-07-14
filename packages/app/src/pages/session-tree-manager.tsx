import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@open-agent-harness/ui/button"
import { Icon } from "@open-agent-harness/ui/icon"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { ProviderIcon } from "@open-agent-harness/ui/provider-icon"
import { Select } from "@open-agent-harness/ui/select"
import { showToast } from "@open-agent-harness/ui/toast"
import { Dialog } from "@open-agent-harness/ui/dialog"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import type { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { agentVisible } from "@/utils/agent"
import { formatServerError } from "@/utils/server-errors"
import { parseConflict, updateBody, type Conflict } from "./session-tree-manager-helpers"
import { automaticResumeMode } from "./session/helpers"

type Status = { type: string; message?: string }

type Node = {
  id: string
  parent_id?: string
  root_id: string
  title: string
  agent?: string
  model?: {
    provider_id: string
    model_id: string
  }
  status: Status
  stats: {
    messages: number
    tokens_input: number
    tokens_output: number
    tool_calls: number
    files: number
    additions: number
    deletions: number
  }
  time: {
    created: number
    updated: number
  }
}

type Row = Node & {
  depth: number
  guides: boolean[]
  last: boolean
}

type ModelState = ReturnType<typeof useLocal>["model"]
type ResumeMode = "auto" | "message"

const resume = new Set(["interrupted"])
const done = new Set(["completed", "terminal_reply"])
const allStatus = "__all__"
const statuses = [
  "aborted",
  "aborting",
  "archived",
  "blocked",
  "completed",
  "error",
  "failed",
  "idle",
  "interrupted",
  "paused",
  "queued",
  "rate_limited",
  "retry",
  "running",
  "starting",
  "timeout",
  "terminal_reply",
  "user_completed",
  "waiting_permission",
  "waiting_user",
  "waiting_child",
]

function rows(nodes: Node[]) {
  const map = nodes.reduce((acc, item) => {
    const key = item.parent_id ?? ""
    acc.set(key, [...(acc.get(key) ?? []), item])
    return acc
  }, new Map<string, Node[]>())
  for (const list of map.values()) list.sort((a, b) => b.time.updated - a.time.updated || a.id.localeCompare(b.id))
  const root = nodes.find((item) => !item.parent_id) ?? nodes[0]
  if (!root) return []
  const visit = (item: Node, depth: number, guides: boolean[], last: boolean): Row[] => {
    const children = map.get(item.id) ?? []
    return [
      { ...item, depth, guides, last },
      ...children.flatMap((child, index) => visit(child, depth + 1, [...guides, !last], index === children.length - 1)),
    ]
  }
  return visit(root, 0, [], true)
}

function statusClass(type: string) {
  if (type === "running" || type === "starting" || type === "queued" || type === "retry") return "bg-icon-info-base"
  if (type === "completed" || type === "terminal_reply" || type === "user_completed") return "bg-icon-success-base"
  if (type === "idle") return "bg-icon-weak-base"
  if (type === "waiting_user" || type === "waiting_permission" || type === "waiting_child" || type === "rate_limited" || type === "blocked")
    return "bg-icon-warning-base"
  return "bg-icon-critical-base"
}

function children(nodes: Node[]) {
  return nodes.reduce((acc, item) => {
    if (!item.parent_id) return acc
    const list = acc.get(item.parent_id)
    if (list) {
      list.push(item.id)
      return acc
    }
    acc.set(item.parent_id, [item.id])
    return acc
  }, new Map<string, string[]>())
}

function keep(nodes: Node[], status: string) {
  if (status === allStatus) return nodes
  const by = new Map(nodes.map((item) => [item.id, item]))
  const ids = new Set<string>()
  for (const item of nodes) {
    if (item.status.type !== status) continue
    let next: Node | undefined = item
    while (next && !ids.has(next.id)) {
      ids.add(next.id)
      next = next.parent_id ? by.get(next.parent_id) : undefined
    }
  }
  return nodes.filter((item) => ids.has(item.id))
}

export default function SessionTreeManager() {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const models = useModels()
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    nodes: [] as Node[],
    selected: {} as Record<string, boolean>,
    loading: false,
    busy: false,
    title: "",
    agent: "",
    agentChanged: false,
    providerID: "",
    modelID: "",
    modelChanged: false,
    statusDraft: allStatus,
    status: allStatus,
    includeDone: false,
    resumeMode: automaticResumeMode() as ResumeMode,
    resumeMessage: "",
    agentConflict: undefined as AgentConflict | undefined,
    modelConflict: undefined as ModelConflict | undefined,
  })

  type AgentConflict = {
    current: string
    next: string
    body: Record<string, unknown>
  }
  type ModelConflict = {
    current: string
    next: string
    body: Record<string, unknown>
  }

  const status = createMemo(() => [
    allStatus,
    ...statuses,
    ...Array.from(new Set(store.nodes.map((item) => item.status.type))).filter((item) => !statuses.includes(item)).sort(),
  ])
  const list = createMemo(() => rows(keep(store.nodes, store.status)))
  const child = createMemo(() => children(store.nodes))
  const picked = createMemo(() => list().filter((item) => store.selected[item.id]).map((item) => item.id))
  const all = createMemo(() => list().length > 0 && picked().length === list().length)
  const resumable = createMemo(() =>
    list()
      .filter((item) => resume.has(item.status.type) || (store.includeDone && done.has(item.status.type)))
      .map((item) => item.id),
  )
  const agent = createMemo(() =>
    sync.data.agent
      .filter(agentVisible)
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b)),
  )
  const current = createMemo(() => {
    if (!store.providerID || !store.modelID) return
    return models.find({ providerID: store.providerID, modelID: store.modelID })
  })
  const model = {
    ready: models.ready,
    current,
    recent: createMemo(() => []),
    list: models.list,
    cycle() {},
    set(item: { providerID: string; modelID: string } | undefined, options?: { recent?: boolean }) {
      setStore("providerID", item?.providerID ?? "")
      setStore("modelID", item?.modelID ?? "")
      setStore("modelChanged", true)
      if (!item) return
      models.setVisibility(item, true)
      if (options?.recent) models.recent.push(item)
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured: () => undefined,
      selected: () => undefined,
      current: () => undefined,
      list: () => [],
      set() {},
      cycle() {},
    },
  } as unknown as ModelState

  const fail = (err: unknown) =>
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })

  const load = async () => {
    if (!params.id) return
    setStore("loading", true)
    try {
      const res = await sdk.request(
        `/session/tree?root=${encodeURIComponent(params.id)}&directory=${encodeURIComponent(sdk.directory)}`,
      )
      if (!res.ok) throw new Error(await res.text())
      const body = (await res.json()) as { nodes: Node[] }
      setStore("nodes", body.nodes)
      setStore("selected", {})
    } catch (err) {
      fail(err)
    } finally {
      setStore("loading", false)
    }
  }

  createEffect(() => {
    void load()
  })

  const descendants = (id: string): string[] => (child().get(id) ?? []).flatMap((next) => [next, ...descendants(next)])
  const select = (item: Node) => {
    const ids = descendants(item.id)
    const selected = !!store.selected[item.id]
    const full = selected && ids.every((id) => store.selected[id])
    const next = selected ? [item.id, ...ids] : [item.id]
    const value = !selected || !full
    setStore(
      "selected",
      produce((draft) => {
        for (const id of next) draft[id] = value
      }),
    )
  }

  const selectAll = () => {
    const value = !all()
    setStore(
      "selected",
      produce((draft) => {
        for (const item of list()) draft[item.id] = value
      }),
    )
  }

  const selectResumable = () => {
    const ids = resumable()
    if (ids.length === 0) {
      showToast({
        title: language.t("sessionTree.noResumable"),
        description: language.t("sessionTree.noResumable.description"),
      })
      return
    }
    setStore("selected", {})
    setStore(
      "selected",
      produce((draft) => {
        for (const id of ids) draft[id] = true
      }),
    )
  }

  const search = () => {
    setStore("status", store.statusDraft)
    setStore("selected", {})
  }

  const post = async (path: string, body: Record<string, unknown>, options?: { onConflict?: (info: Conflict) => void }) => {
    const ids = picked()
    if (ids.length === 0) return
    setStore("busy", true)
    try {
      const res = await sdk.request(path, {
        method: path.includes("/sessions") ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: sdk.directory, ids, ...body }),
      })
      if (!res.ok) {
        const text = await res.text()
        if (res.status === 409 && options?.onConflict) {
          const data = parseConflict(text)
          if (data) {
            options.onConflict(data)
            return false
          }
        }
        throw new Error(text)
      }
      const data = path.includes("/resume")
        ? ((await res.json().catch(() => undefined)) as { resumed?: number } | undefined)
        : undefined
      await load()
      if (params.id && ids.includes(params.id)) await sync.session.sync(params.id, { force: true }).catch(() => undefined)
      if (data?.resumed === 0) {
        showToast({
          title: "No resumable sessions",
          description: "Use resume message mode for stopped sessions, or refresh to see the latest status.",
        })
        return false
      }
      showToast({
        variant: "success",
        title: language.t("sessionTree.updated", { count: data?.resumed ?? ids.length }),
      })
      return true
    } catch (err) {
      fail(err)
      return false
    } finally {
      setStore("busy", false)
    }
  }

  const update = (confirm = false) => {
    const body = updateBody({
      title: store.title,
      agent: store.agent,
      agentChanged: store.agentChanged,
      providerID: store.providerID,
      modelID: store.modelID,
      modelChanged: store.modelChanged,
      confirm,
    })
    if (Object.keys(body).length === 0) return
    const next = String(body.agent ?? "")
    if (!confirm && body.model !== undefined) {
      const model = body.model as { providerID: string; modelID: string }
      setStore("modelConflict", { current: "", next: `${model.providerID}/${model.modelID}`, body })
      dialog.show(() => <DialogModelConflict />)
      return
    }
    void post(
      "/session/tree/sessions",
      body,
      confirm || body.agent === undefined
        ? undefined
        : {
            onConflict: (conflict) => {
              if (conflict.type === "model") {
                setStore("modelConflict", { current: conflict.current, next: conflict.next, body })
                dialog.show(() => <DialogModelConflict />)
                return
              }
              setStore("agentConflict", { current: conflict.current || next, next: conflict.next || next, body })
              dialog.show(() => <DialogAgentConflict />)
            },
          },
    ).then((ok) => {
      if (!ok) return
      if (body.agent !== undefined) setStore("agentChanged", false)
      if (body.model !== undefined) setStore("modelChanged", false)
    })
  }

  const abort = () => void post("/session/tree/abort", { source_session: params.id })
  const submit = () => {
    dialog.close()
    void post("/session/tree/resume", {
      source_session: params.id,
      include_completed: store.includeDone,
      mode: store.resumeMode,
      message: store.resumeMode === "message" ? store.resumeMessage.trim() || undefined : undefined,
    })
  }
  const cont = () => {
    setStore("resumeMode", automaticResumeMode())
    setStore("resumeMessage", language.t("sessionTree.resumeDialog.defaultMessage"))
    dialog.show(() => <DialogResume />)
  }
  const open = (id: string) => navigate(`/${params.dir}/session/${id}`)

  function DialogAgentConflict() {
    const conflict = store.agentConflict
    if (!conflict) return null
    return (
      <Dialog
        title={language.t("sessionTree.confirmAgent.title")}
        fit
      >
        <div class="flex flex-col gap-4 px-5 pb-4 min-w-[360px]">
          <div class="text-12-regular text-text-weak">
            {language.t("sessionTree.confirmAgent.description")}
          </div>
          <div class="flex flex-col gap-1 text-12-regular">
            <div class="text-text-weak">
              {language.t("sessionTree.confirmAgent.current", { current: conflict.current || "—" })}
            </div>
            <div class="text-text-strong">
              {language.t("sessionTree.confirmAgent.next", { next: conflict.next })}
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                setStore("agentConflict", undefined)
                update(true)
              }}
            >
              {language.t("sessionTree.confirmAgent.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogModelConflict() {
    const conflict = store.modelConflict
    if (!conflict) return null
    return (
      <Dialog
        title={language.t("sessionTree.confirmModel.title")}
        fit
      >
        <div class="flex flex-col gap-4 px-5 pb-4 min-w-[360px]">
          <div class="text-12-regular text-text-weak">
            {language.t("sessionTree.confirmModel.description")}
          </div>
          <div class="flex flex-col gap-1 text-12-regular">
            <Show when={conflict.current}>
              <div class="text-text-weak">
                {language.t("sessionTree.confirmModel.current", { current: conflict.current })}
              </div>
            </Show>
            <div class="text-text-strong">
              {language.t("sessionTree.confirmModel.next", { next: conflict.next })}
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                setStore("modelConflict", undefined)
                update(true)
              }}
            >
              {language.t("sessionTree.confirmModel.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResume() {
    return (
      <Dialog title={language.t("sessionTree.resumeDialog.title")} fit>
        <div class="flex flex-col gap-4 px-5 pb-4 min-w-[360px]">
          <div class="text-12-regular text-text-weak">
            {language.t("sessionTree.resumeDialog.count", { count: picked().length })}
          </div>
          <div class="flex flex-col gap-2">
            <button
              class="text-left rounded-md border border-border-weak-base px-3 py-2 hover:bg-surface-raised-base-hover"
              classList={{
                "border-border-focus-base bg-surface-raised-base-active": store.resumeMode === "auto",
              }}
              onClick={() => setStore("resumeMode", automaticResumeMode())}
            >
              <div class="flex items-center gap-2 text-13-medium text-text-strong">
                <input type="radio" checked={store.resumeMode === "auto"} readOnly />
                {language.t("sessionTree.resumeDialog.restore")}
              </div>
              <div class="mt-1 pl-6 text-12-regular text-text-weak">
                {language.t("sessionTree.resumeDialog.restore.description")}
              </div>
            </button>
            <button
              class="text-left rounded-md border border-border-weak-base px-3 py-2 hover:bg-surface-raised-base-hover"
              classList={{
                "border-border-focus-base bg-surface-raised-base-active": store.resumeMode === "message",
              }}
              onClick={() => setStore("resumeMode", "message")}
            >
              <div class="flex items-center gap-2 text-13-medium text-text-strong">
                <input type="radio" checked={store.resumeMode === "message"} readOnly />
                {language.t("sessionTree.resumeDialog.message")}
              </div>
              <div class="mt-1 pl-6 text-12-regular text-text-weak">
                {language.t("sessionTree.resumeDialog.message.description")}
              </div>
            </button>
          </div>
          <Show when={store.resumeMode === "message"}>
            <textarea
              class="min-h-24 rounded-md border border-border-weak-base bg-surface-panel px-3 py-2 text-13-regular outline-none resize-y"
              value={store.resumeMessage}
              placeholder={language.t("sessionTree.resumeDialog.messagePlaceholder")}
              onInput={(e) => setStore("resumeMessage", e.currentTarget.value)}
              autofocus
            />
          </Show>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={submit}>
              {language.t("sessionTree.resumeDialog.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <div class="h-full min-h-0 flex flex-col bg-background-base text-text-base">
      <div class="h-12 shrink-0 border-b border-border-weak-base px-4 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <IconButton icon="chevron-left" variant="ghost" class="size-8" onClick={() => open(params.id ?? "")} />
          <Icon name="branch" size="small" class="text-icon-weak" />
          <div class="text-14-medium text-text-strong truncate">{language.t("sessionTree.title")}</div>
          <div class="text-12-regular text-text-weak shrink-0">{store.nodes.length}</div>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="small" onClick={selectResumable} disabled={store.busy}>
            {language.t("sessionTree.selectResumable")}
          </Button>
          <Button variant="ghost" size="small" onClick={selectAll} disabled={store.busy}>
            {all() ? language.t("sessionTree.clear") : language.t("sessionTree.selectAll")}
          </Button>
          <Button variant="ghost" size="small" onClick={() => void load()} disabled={store.loading || store.busy}>
            {language.t("common.refresh")}
          </Button>
        </div>
      </div>

      <div class="shrink-0 border-b border-border-weak-base px-4 py-3 grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-3">
        <div class="grid grid-cols-1 md:grid-cols-[minmax(120px,1fr)_minmax(120px,180px)_minmax(180px,320px)_minmax(120px,180px)_auto] gap-2">
          <input
            class="h-8 rounded-md border border-border-weak-base bg-surface-panel px-2 text-12-regular outline-none"
            value={store.title}
            placeholder={language.t("sessionTree.titlePlaceholder")}
            onInput={(e) => setStore("title", e.currentTarget.value)}
          />
          <Select
            size="small"
            variant="secondary"
            options={agent()}
            current={store.agent}
            placeholder={language.t("sessionTree.agentPlaceholder")}
            onSelect={(name) => {
              setStore("agent", name ?? "")
              setStore("agentChanged", true)
            }}
            class="h-8 min-w-0"
            valueClass="truncate text-12-regular"
          />
          <ModelSelectorPopover
            model={model}
            triggerAs={Button}
            triggerProps={{
              variant: "secondary",
              size: "small",
              class: "h-8 min-w-0 justify-start text-12-regular group",
            }}
          >
            <Show when={current()?.provider.id}>
              <ProviderIcon id={current()!.provider.id} class="size-4 shrink-0 opacity-50 group-hover:opacity-100" />
            </Show>
            <span class="truncate">{current()?.name ?? language.t("sessionTree.modelPlaceholder")}</span>
            <Icon name="chevron-down" size="small" class="shrink-0 ml-auto" />
          </ModelSelectorPopover>
          <select
            class="h-8 min-w-0 rounded-md border border-border-weak-base bg-surface-panel px-2 text-12-regular outline-none"
            value={store.statusDraft}
            onChange={(e) => setStore("statusDraft", e.currentTarget.value || allStatus)}
          >
            <For each={status()}>
              {(item) => <option value={item}>{item === allStatus ? language.t("sessionTree.statusAll") : item}</option>}
            </For>
          </select>
          <Button variant="secondary" size="small" class="h-8" onClick={search} disabled={store.busy}>
            <Icon name="magnifying-glass" size="small" />
            {language.t("sessionTree.search")}
          </Button>
        </div>
        <div class="flex items-center gap-3 justify-end">
          <label class="flex items-center gap-2 text-12-regular text-text-base whitespace-nowrap">
            <input
              type="checkbox"
              class="size-4"
              checked={store.includeDone}
              onChange={(e) => setStore("includeDone", e.currentTarget.checked)}
            />
            {language.t("sessionTree.includeCompleted")}
          </label>
          <Button variant="ghost" size="small" onClick={update} disabled={store.busy || picked().length === 0}>
            <Icon name="edit" size="small" />
            {language.t("sessionTree.update")}
          </Button>
          <Button variant="ghost" size="small" onClick={abort} disabled={store.busy || picked().length === 0}>
            <Icon name="stop" size="small" />
            {language.t("sessionTree.abort")}
          </Button>
          <Button variant="primary" size="small" onClick={cont} disabled={store.busy || picked().length === 0}>
            <Icon name="status-active" size="small" />
            {language.t("sessionTree.resume")}
          </Button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto">
        <Show
          when={!store.loading}
          fallback={<div class="px-4 py-3 text-12-regular text-text-weak">{language.t("common.loading")}</div>}
        >
          <div class="sticky top-0 z-10 grid grid-cols-[auto_auto_1fr_auto] min-h-8 items-center border-b border-border-weak-base bg-background-base px-3 text-11-regular text-text-weak">
            <div class="w-4" />
            <div class="w-5" />
            <div class="min-w-0">{language.t("sessionTree.column.session")}</div>
            <div class="hidden lg:grid grid-cols-3 gap-4 text-right pr-2">
              <span>{language.t("sessionTree.column.messages")}</span>
              <span>{language.t("sessionTree.column.additions")}</span>
              <span>{language.t("sessionTree.column.deletions")}</span>
            </div>
          </div>
          <For each={list()}>
            {(item) => (
              <div
                class="grid grid-cols-[auto_auto_1fr_auto] min-h-9 items-center border-b border-border-weak-base/60 px-3 hover:bg-surface-raised-base-hover"
                classList={{
                  "bg-surface-raised-base-active": !!store.selected[item.id],
                  "shadow-[inset_2px_0_0_var(--border-focus-base)]": !!store.selected[item.id],
                }}
              >
                <input
                  type="checkbox"
                  class="size-4"
                  checked={!!store.selected[item.id]}
                  onChange={() => select(item)}
                />
                <div class="relative h-full shrink-0" style={{ width: `${item.depth * 16 + 20}px` }}>
                  <For each={item.guides}>
                    {(guide, index) => (
                      <div
                        class="absolute top-0 bottom-0 border-l border-border-strong-base"
                        classList={{ hidden: !guide }}
                        style={{ left: `${index() * 16 + 9}px` }}
                      />
                    )}
                  </For>
                  <Show when={item.depth > 0}>
                    <div
                      class="absolute top-1/2 h-px w-3 border-t border-border-strong-base"
                      style={{ left: `${item.depth * 16 - 7}px` }}
                    />
                    <div
                      class="absolute top-0 bottom-1/2 border-l border-border-strong-base"
                      style={{ left: `${item.depth * 16 - 7}px` }}
                    />
                  </Show>
                  <Show when={item.depth > 0 && !item.last}>
                    <div
                      class="absolute top-1/2 bottom-0 border-l border-border-strong-base"
                      style={{ left: `${item.depth * 16 - 7}px` }}
                    />
                  </Show>
                </div>
                <button class="min-w-0 text-left flex items-center gap-2 py-1.5" onClick={() => open(item.id)}>
                  <Show
                    when={item.status.type === "user_completed"}
                    fallback={<span class={`size-2 rounded-full shrink-0 ${statusClass(item.status.type)}`} />}
                  >
                    <Icon name="circle-check" size="small" class="shrink-0 text-icon-success-base" />
                  </Show>
                  <span class="truncate text-13-medium text-text-strong">{item.title}</span>
                  <span class="text-11-regular text-text-weak shrink-0">{item.status.type}</span>
                  <Show when={item.model}>
                    {(model) => (
                      <span class="hidden md:inline text-11-regular text-text-weak truncate">
                        {model().provider_id}/{model().model_id}
                      </span>
                    )}
                  </Show>
                </button>
                <div class="hidden lg:flex items-center gap-4 text-11-regular text-text-weak pr-2">
                  <span>{item.stats.messages}</span>
                  <span>+{item.stats.additions}</span>
                  <span>-{item.stats.deletions}</span>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
