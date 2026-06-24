import type { Project, UserMessage } from "@open-agent-harness/sdk/v2"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createSignal,
  createEffect,
  createComputed,
  on,
  onMount,
  untrack,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@open-agent-harness/ui/resize-handle"
import { Select } from "@open-agent-harness/ui/select"
import { Spinner } from "@open-agent-harness/ui/spinner"
import { Tabs } from "@open-agent-harness/ui/tabs"
import { createAutoScroll } from "@open-agent-harness/ui/hooks"
import { previewSelectedLines } from "@open-agent-harness/ui/pierre/selection-bridge"
import { Button } from "@open-agent-harness/ui/button"
import { Icon } from "@open-agent-harness/ui/icon"
import { Tooltip, TooltipKeybind } from "@open-agent-harness/ui/tooltip"
import type { SessionTurnFilter } from "@open-agent-harness/ui/session-turn"
import { showToast } from "@open-agent-harness/ui/toast"
import { base64Encode, checksum } from "@open-agent-harness/util/encode"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { StatusPopover } from "@/components/status-popover"
import { NewSessionView } from "@/components/session"
import { useCommand } from "@/context/command"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import {
  createOpenReviewFile,
  createSessionTabs,
  createSizing,
  focusTerminalById,
  isSessionBusy,
  resumePrompt,
} from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SessionLogTimeline } from "@/pages/session/session-log-timeline"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { extractPromptFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"

const emptyUserMessages: UserMessage[] = []
const emptyFollowups: (FollowupDraft & { id: string })[] = []
const encoder = new TextEncoder()
const bytes = (input: unknown) => encoder.encode(JSON.stringify(input) ?? "").length

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  measure: (message: UserMessage) => number
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnMax = 10
  const byteMax = 10_000
  const turnBatch = 1
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (msgs: UserMessage[]) => {
    if (msgs.length <= 1) return 0

    let total = 0
    let count = 0
    for (let i = msgs.length - 1; i >= 0 && count < turnMax; i--) {
      const msg = msgs[i]
      if (!msg) continue
      const next = Math.max(1, input.measure(msg))
      if (count > 0 && total + next > byteMax) break
      total += next
      count += 1
    }

    return Math.max(0, msgs.length - Math.max(1, count))
  }

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const msgs = input.visibleUserMessages()
    const len = msgs.length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(msgs)
    if (state.turnStart <= 0) return 0
    if (state.turnStart >= len) return initialTurnStart(msgs)
    return state.turnStart
  })

  const setTurnStart = (start: number) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    if (!id) {
      setState({ turnID: undefined, turnStart: next })
      return
    }
    setState({ turnID: id, turnStart: next })
  }

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      if (start <= 0) return msgs
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  /** Button path: reveal all cached turns, fetch older history, reveal one batch. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) setTurnStart(0)

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    setTurnStart(Math.max(0, afterVisible - target))
  }

  /** Scroll/prefetch path: fetch older history from server. */
  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return
    if (turnStart() !== start) return

    const reveal = !opts?.prefetch
    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = reveal ? Math.min(afterVisible, base + turnBatch) : base
    const nextStart = Math.max(0, afterVisible - target)
    preserveScroll(() => setTurnStart(nextStart))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0 })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.messagesReady()] as const,
      ([id, ready]) => {
        if (!id || !ready) return
        setTurnStart(initialTurnStart(input.visibleUserMessages()))
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}

export default function Page() {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const command = useCommand()
  const file = useFile()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()
  const settings = useSettings()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  createEffect(() => {
    if (!untrack(() => prompt.ready())) return
    prompt.ready()
    untrack(() => {
      if (params.id || !prompt.ready()) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    git: false,
    pendingMessage: undefined as string | undefined,
    restoring: undefined as string | undefined,
    reverting: false,
    resuming: false,
    missing: undefined as string | undefined,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
    },
  })

  const composer = createSessionComposerState()

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const [frame, setFrame] = createSignal<HTMLDivElement>()
  const [topbar, setTopbar] = createSignal<HTMLElement>()
  const [wide, setWide] = createSignal(0)
  const paneMin = 320
  const sideMin = 320
  const desktopSidePanelOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const bound = createMemo(() => {
    const full = wide() || (typeof window === "undefined" ? 1600 : window.innerWidth)
    return Math.max(paneMin, full - sideMin)
  })
  const pane = createMemo(() =>
    desktopSidePanelOpen() ? Math.min(layout.session.width(), bound()) : layout.session.width(),
  )
  const sessionPanelWidth = createMemo(() => (desktopSidePanelOpen() ? `${pane()}px` : "100%"))
  const max = () => bound()
  const centered = createMemo(() => isDesktop() && !desktopSidePanelOpen())

  createResizeObserver(
    () => frame(),
    ({ width }) => setWide(Math.floor(width)),
  )

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTree = () => {
    if (!params.id) return
    navigate(`/${params.dir}/session/${params.id}/tree`)
  }

  const toggleTerminal = () => {
    const next = !view().terminal.opened()
    view().terminal.toggle()
    if (!next) return

    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  const openReview = () => {
    view().reviewPanel.open()
    tabs().setActive("review")
  }

  const openFiles = () => {
    view().reviewPanel.open()
    layout.fileTree.open()
    tabs().setActive(layout.fileTree.tab())
  }

  const toggleSidePanel = () => {
    if (view().reviewPanel.opened()) {
      view().reviewPanel.close()
      return
    }
    view().reviewPanel.open()
    if (!activeTab()) tabs().setActive("review")
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const status = createMemo(() => (params.id ? sync.data.session_status[params.id] : undefined))
  const resumable = createMemo(() => resumePrompt(status()))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))
  const measure = (message: UserMessage) => {
    const list = messages()
    const idx = list.findIndex((item) => item.id === message.id)
    if (idx === -1) return bytes(message)

    let total = 0
    for (let i = idx; i < list.length; i++) {
      const item = list[i]
      if (!item) continue
      if (i !== idx && item.role === "user") break
      total += bytes(item)
      total += bytes(sync.data.part[item.id] ?? [])
    }
    return total
  }

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes" | "logs",
    changes: "session" as "session" | "turn",
    filter: "all" as SessionTurnFilter,
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [followup, setFollowup] = createStore({
    items: {} as Record<string, (FollowupDraft & { id: string })[] | undefined>,
    sending: {} as Record<string, string | undefined>,
    failed: {} as Record<string, string | undefined>,
    paused: {} as Record<string, boolean | undefined>,
    edit: {} as Record<
      string,
      { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] } | undefined
    >,
  })

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  const turnDiffs = createMemo(() => lastUserMessage()?.summary?.diffs ?? [])
  const reviewDiffs = createMemo(() => (store.changes === "session" ? diffs() : turnDiffs()))

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })
  const reviewEmptyKey = createMemo(() => {
    const project = sync.project
    if (project && !project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.empty"
  })

  function upsert(next: Project) {
    const list = globalSync.data.project
    sync.set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      globalSync.set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      globalSync.set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    globalSync.set("project", [...list, next])
  }

  function initGit() {
    if (ui.git) return
    setUi("git", true)
    void sdk.client.project
      .initGit()
      .then((x) => {
        if (!x.data) return
        upsert(x.data)
      })
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
      })
      .finally(() => {
        setUi("git", false)
      })
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  const notFound = (err: unknown) => {
    const text = err instanceof Error ? err.message : JSON.stringify(err)
    return /404|not found/i.test(text)
  }

  const syncCurrentSession = (id: string, opts?: { force?: boolean }) =>
    sync.session.sync(id, opts).catch((err) => {
      if (params.id !== id) return
      if (!notFound(err)) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
        return
      }
      if (ui.missing === id) return
      setUi("missing", id)
      showToast({
        variant: "error",
        title: "Session unavailable",
        description: "This session no longer exists. Returning to a new session.",
      })
      navigate(`/${params.dir}/session`, { replace: true })
    })

  const recover = () => {
    const id = params.id
    if (!id || ui.resuming) return
    setUi("resuming", true)
    sdk
      .request("/session/tree/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: sdk.directory,
          ids: [id],
          source: "user",
          source_session: id,
          mode: "restore",
          reason: "User chose to continue an interrupted session.",
        }),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        await syncCurrentSession(id, { force: true })
        resumeScroll()
      })
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
      })
      .finally(() => {
        setUi("resuming", false)
      })
  }

  const recovery = () => {
    const item = resumable()
    if (!item) return
    return {
      prompt: item,
      busy: ui.resuming,
      onResume: recover,
    }
  }

  createEffect(
    on([() => sdk.directory, () => params.id] as const, ([, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(sdk.directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()
      const todos = untrack(() => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined)

      untrack(() => {
        void syncCurrentSession(id)
      })

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void syncCurrentSession(id, { force: true })
            void sync.session.todo(id, todos ? { force: true } : undefined)
          })
        }, 0)
      })
    }),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("changes", "session")
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked()) return
      inputRef?.focus()
    }
  }

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const mobileLogs = createMemo(() => !isDesktop() && store.mobileTab === "logs")

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesOptions = ["session", "turn"] as const
  const changesOptionsList = [...changesOptions]

  const changesTitle = () => {
    if (!hasReview()) {
      return null
    }

    return (
      <Select
        options={changesOptionsList}
        current={store.changes}
        label={(option) =>
          option === "session" ? language.t("ui.sessionReview.title") : language.t("ui.sessionReview.title.lastTurn")
        }
        onSelect={(option) => option && setStore("changes", option)}
        variant="ghost"
        size="small"
        valueClass="text-14-medium"
      />
    )
  }

  const emptyTurn = () => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.noChanges")}</div>
    </div>
  )

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (store.changes === "turn") return emptyTurn()

    if (hasReview() && !diffsReady()) {
      return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
    }

    if (reviewEmptyKey() === "session.review.noVcs") {
      return (
        <div class={input.emptyClass}>
          <div class="flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
            <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("session.review.noVcs.createGit.description")}
            </div>
          </div>
          <Button size="large" disabled={ui.git} onClick={initGit}>
            {ui.git
              ? language.t("session.review.noVcs.createGit.actionLoading")
              : language.t("session.review.noVcs.createGit.action")}
          </Button>
        </div>
      )
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{language.t(reviewEmptyKey())}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  const logPanel = () => (
    <Show when={params.id} keyed>
      {(id) => <SessionLogTimeline sessionID={id} />}
    </Show>
  )

  const sessionLoadingPanel = () => (
    <div
      class="flex h-full min-h-0 flex-col items-center justify-center gap-3 text-text-weak"
      data-component="session-loading"
    >
      <Spinner class="size-5" />
      <div class="text-13-regular">
        {language.t("session.messages.loading")}
        {language.t("common.loading.ellipsis")}
      </div>
    </div>
  )

  const sessionPanel = () => (
    <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
      <div class="flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Match when={params.id}>
            <Show
              when={mobileLogs()}
              fallback={
                <Show when={messagesReady()} fallback={sessionLoadingPanel()}>
                  <MessageTimeline
                    mobileChanges={mobileChanges()}
                    mobileFallback={reviewContent({
                      diffStyle: "unified",
                      classes: {
                        root: "pb-8",
                        header: "px-4",
                        container: "px-4",
                      },
                      loadingClass: "px-4 py-4 text-text-weak",
                      emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                    })}
                    actions={actions}
                    request={{
                      question: composer.questionRequest(),
                      permission: composer.permissionRequest(),
                      responding: composer.permissionResponding(),
                      submit: () => {
                        if (params.id) void syncCurrentSession(params.id, { force: true })
                      },
                      decide: (response) => {
                        resumeScroll()
                        composer.decide(response)
                      },
                    }}
                    todos={composer.todos()}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    onUserScroll={markUserScroll}
                    onTurnBackfillScroll={historyWindow.onScrollerScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    centered={centered()}
                    setContentRef={(el) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    turnStart={historyWindow.turnStart()}
                    historyMore={historyMore()}
                    historyLoading={historyLoading()}
                    onLoadEarlier={() => {
                      void historyWindow.loadAndReveal()
                    }}
                    renderedUserMessages={historyWindow.renderedUserMessages()}
                    anchor={anchor}
                    filter={store.filter}
                    onFilterChange={(filter) => setStore("filter", filter)}
                    onJumpPreviousUserInput={() => navigateMessageByOffset(-1)}
                    onJumpNextUserInput={() => navigateMessageByOffset(1)}
                    canJumpUserInput={visibleUserMessages().length > 1}
                  />
                </Show>
              }
            >
              {logPanel()}
            </Show>
          </Match>
          <Match when={true}>
            <NewSessionView worktree={newSessionWorktree()} />
          </Match>
        </Switch>
      </div>
    </div>
  )

  const composerPanel = () => (
    <SessionComposerRegion
      state={composer}
      ready={!store.deferRender && messagesReady()}
      centered={centered()}
      inputRef={(el) => {
        inputRef = el
      }}
      newSessionWorktree={newSessionWorktree()}
      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
      onSubmit={() => {
        comments.clear()
        resumeScroll()
      }}
      followup={
        params.id
          ? {
              queue: queueEnabled,
              target: followupTarget(),
              items: followupDock(),
              sending: sendingFollowup(),
              edit: editingFollowup(),
              onQueue: queueFollowup,
              onAbort: () => {
                const id = params.id
                if (!id) return
                setFollowup("paused", id, true)
              },
              onSend: (id) => {
                void sendFollowup(params.id!, id, { manual: true })
              },
              onEdit: editFollowup,
              onEditLoaded: clearFollowupEdit,
            }
          : undefined
      }
      revert={
        rolled().length > 0
          ? {
              items: rolled(),
              restoring: ui.restoring,
              disabled: ui.reverting,
              onRestore: restore,
            }
          : undefined
      }
      resume={recovery()}
      setPromptDockRef={(el) => {
        promptDock = el
      }}
    />
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    view().review.openPath(path)
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    const wants = isDesktop() ? desktopFileTreeOpen() || activeTab() === "review" : store.mobileTab === "changes"
    if (!wants) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () =>
        [
          sessionKey(),
          isDesktop() ? desktopFileTreeOpen() || activeTab() === "review" : store.mobileTab === "changes",
        ] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")

        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const overflow = max > 1
    const bottom = !overflow || el.scrollTop >= max - 2

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom) return
    setUi("scroll", { overflow, bottom })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => params.id,
    messagesReady,
    loaded: () => messages().length,
    visibleUserMessages,
    measure,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const busy = (sessionID: string) => isSessionBusy(sync.data.session_status[sessionID], sync.data.message[sessionID])

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const followupTarget = createMemo(() => {
    const id = params.id
    if (!id) return
    return sync.session.get(id)?.title?.trim() || id
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.sending[id]
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followup.sending[sessionID]) return Promise.resolve()

    if (opts?.manual) setFollowup("paused", sessionID, undefined)
    setFollowup("sending", sessionID, id)
    setFollowup("failed", sessionID, undefined)

    return sendFollowupDraft({
      client: sdk.client,
      sync,
      globalSync,
      draft: item,
      optimisticBusy: item.sessionDirectory === sdk.directory,
    })
      .then((ok) => {
        if (ok === false) return
        setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
        if (opts?.manual) resumeScroll()
      })
      .catch((err) => {
        setFollowup("failed", sessionID, id)
        fail(err)
      })
      .finally(() => {
        setFollowup("sending", sessionID, (value) => (value === id ? undefined : value))
      })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followup.sending[sessionID]) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const fork = (input: { sessionID: string; messageID: string }) => {
    const value = draft(input.messageID)
    const dir = base64Encode(sdk.directory)
    return sdk.client.session
      .fork(input)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        prompt.set(value, undefined, { dir, id: next.id })
        navigate(`/${dir}/session/${next.id}`)
      })
      .catch(fail)
  }

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (ui.reverting || ui.restoring) return
    const prev = prompt.current().slice()
    const last = info()?.revert
    const value = draft(input.messageID)
    batch(() => {
      setUi("reverting", true)
      roll(input.sessionID, { messageID: input.messageID })
      prompt.set(value)
    })
    return halt(input.sessionID)
      .then(() => sdk.client.session.revert(input))
      .then((result) => {
        if (result.data) merge(result.data)
      })
      .catch((err) => {
        batch(() => {
          roll(input.sessionID, last)
          prompt.set(prev)
        })
        fail(err)
      })
      .finally(() => {
        setUi("reverting", false)
      })
  }

  const restore = (id: string) => {
    const sessionID = params.id
    if (!sessionID || ui.restoring || ui.reverting) return

    const next = userMessages().find((item) => item.id > id)
    const prev = prompt.current().slice()
    const last = info()?.revert

    batch(() => {
      setUi("restoring", id)
      setUi("reverting", true)
      roll(sessionID, next ? { messageID: next.id } : undefined)
      if (next) {
        prompt.set(draft(next.id))
        return
      }
      prompt.reset()
    })

    const task = !next
      ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
      : halt(sessionID).then(() =>
          sdk.client.session.revert({
            sessionID,
            messageID: next.id,
          }),
        )

    return task
      .then((result) => {
        if (result.data) merge(result.data)
      })
      .catch((err) => {
        batch(() => {
          roll(sessionID, last)
          prompt.set(prev)
        })
        fail(err)
      })
      .finally(() => {
        batch(() => {
          setUi("restoring", (value) => (value === id ? undefined : value))
          setUi("reverting", false)
        })
      })
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const shellText = (input: { text: string }) => ({
    id: Identifier.ascending("part"),
    type: "text" as const,
    text: input.text,
  })

  const shellModel = () => {
    const item = local.model.current()
    if (!item) return
    return {
      providerID: item.provider.id,
      modelID: item.id,
    }
  }

  const code = (err: unknown) => {
    const item = err as { status?: number; response?: { status?: number } }
    return item.status ?? item.response?.status
  }

  const modelChange = (model: { providerID: string; modelID: string }) => {
    const bound = info()?.model
    if (!bound) return
    if (bound.providerID === model.providerID && bound.modelID === model.modelID) return
    const label = (item: { providerID: string; modelID: string }) => `${item.providerID}/${item.modelID}`
    const ok =
      globalThis.confirm?.(`This session is bound to ${label(bound)}. Switch it to ${label(model)} before sending?`) ??
      false
    if (ok) return { model, confirm: true }
    local.model.set(bound)
    return { model: bound, confirm: false }
  }

  const addShellContext = async (input: { sessionID: string; text: string }) => {
    const model = shellModel()
    const agent = local.agent.current()?.name
    if (!model || !agent) return
    const send = (item: { model: typeof model; confirm?: boolean }) => {
      return sdk.client.session.prompt({
        sessionID: input.sessionID,
        agent,
        model: item.model,
        confirm: item.confirm,
        noReply: true,
        parts: [shellText(input)],
      })
    }
    await send({ model }).catch((err) => {
      const next = code(err) === 409 ? modelChange(model) : undefined
      if (next) return send(next)
      throw err
    })
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("session.share.copy.copied"),
      description: "Shell output added to context",
    })
  }

  const sendShellPrompt = async (input: { sessionID: string; text: string }) => {
    const model = shellModel() ?? info()?.model
    const agent = local.agent.current()?.name ?? info()?.agent
    if (!model || !agent) return
    const send = (item: { model: typeof model; confirm?: boolean }) => {
      return sdk.client.session.promptAsync({
        sessionID: input.sessionID,
        agent,
        model: item.model,
        confirm: item.confirm,
        parts: [shellText(input)],
      })
    }
    await send({ model }).catch((err) => {
      const next = code(err) === 409 ? modelChange(model) : undefined
      if (next) return send(next)
      throw err
    })
  }

  const retry = (_input: { sessionID: string; messageID: string }) => {
    const body = {
      directory: sdk.directory,
      ids: [_input.sessionID],
      source_session: _input.sessionID,
      mode: "restore" as const,
    }
    return sdk
      .request("/session/tree/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`request failed: ${res.status}`))
        return syncCurrentSession(_input.sessionID, { force: true })
      })
      .catch(fail)
  }

  const continueAction = (input: { sessionID: string; messageID: string; text: string }) => {
    const text = input.text.trim()
    if (!text) return
    return sendShellPrompt({
      sessionID: input.sessionID,
      text,
    }).catch(fail)
  }

  const actions = {
    fork,
    revert,
    retry,
    continue: continueAction,
    context: addShellContext,
    prompt: sendShellPrompt,
  }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followup.sending[sessionID]) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    turnStart: historyWindow.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    setTopbar(document.getElementById("opencode-titlebar-right") ?? undefined)
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <Show when={topbar()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Show when={isDesktop() && params.id}>
              <div class="flex items-center gap-1">
                <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                  <StatusPopover />
                </Tooltip>
                <Tooltip placement="bottom" value={language.t("sessionTree.open")}>
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                    onClick={openTree}
                    aria-label={language.t("sessionTree.open")}
                  >
                    <Icon size="small" name="branch" />
                  </Button>
                </Tooltip>
                <TooltipKeybind title={language.t("command.terminal.toggle")} keybind={command.keybind("terminal.toggle")}>
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                    onClick={toggleTerminal}
                    aria-label={language.t("command.terminal.toggle")}
                    aria-expanded={view().terminal.opened()}
                    aria-controls="terminal-panel"
                  >
                    <Icon size="small" name={view().terminal.opened() ? "terminal-active" : "terminal"} />
                  </Button>
                </TooltipKeybind>
                <TooltipKeybind title={language.t("command.review.toggle")} keybind={command.keybind("review.toggle")}>
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                    onClick={openReview}
                    aria-label={language.t("command.review.toggle")}
                    aria-expanded={desktopSidePanelOpen() && activeTab() === "review"}
                    aria-controls="review-panel"
                  >
                    <Icon size="small" name={desktopSidePanelOpen() && activeTab() === "review" ? "review-active" : "review"} />
                  </Button>
                </TooltipKeybind>
                <TooltipKeybind title={language.t("command.fileTree.toggle")} keybind={command.keybind("fileTree.toggle")}>
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                    onClick={openFiles}
                    aria-label={language.t("command.fileTree.toggle")}
                    aria-expanded={desktopSidePanelOpen() && layout.fileTree.opened() && (activeTab() === "changes" || activeTab() === "all")}
                    aria-controls="file-tree-panel"
                  >
                    <Icon
                      size="small"
                      name={
                        desktopSidePanelOpen() && layout.fileTree.opened() && (activeTab() === "changes" || activeTab() === "all")
                          ? "file-tree-active"
                          : "file-tree"
                      }
                    />
                  </Button>
                </TooltipKeybind>
                <Tooltip
                  placement="bottom"
                  value={language.t(desktopSidePanelOpen() ? "session.panel.collapse" : "session.panel.expand")}
                >
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                    onClick={toggleSidePanel}
                    aria-label={language.t(desktopSidePanelOpen() ? "session.panel.collapse" : "session.panel.expand")}
                    aria-expanded={desktopSidePanelOpen()}
                    aria-controls="review-panel"
                  >
                    <Icon size="small" name={desktopSidePanelOpen() ? "chevron-right" : "chevron-left"} />
                  </Button>
                </Tooltip>
              </div>
            </Show>
          </Portal>
        )}
      </Show>
      <div ref={setFrame} class="flex-1 min-h-0 flex flex-col md:flex-row">
        <Show when={!isDesktop() && !!params.id}>
          <Tabs value={store.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/3 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                {language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="logs"
                class="!w-1/3 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "logs")}
              >
                {language.t("session.tab.logs")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/3 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "changes")}
              >
                {hasReview()
                  ? language.t("session.review.filesChanged", { count: reviewCount() })
                  : language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        <Show
          when={isDesktop()}
          fallback={
            <div class="@container relative flex flex-col min-h-0 h-full bg-background-stronger flex-1">
              {sessionPanel()}
              {composerPanel()}
            </div>
          }
        >
          <div
            classList={{
              "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none min-w-0": true,
              "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !size.active(),
            }}
            style={{
              width: sessionPanelWidth(),
            }}
          >
            {sessionPanel()}
            {composerPanel()}
            <Show when={desktopSidePanelOpen()}>
              <div onPointerDown={() => size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  size={pane()}
                  min={320}
                  max={max()}
                  onResize={(width) => {
                    size.touch()
                    layout.session.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>
          <SessionSidePanel
            reviewPanel={reviewPanel}
            logPanel={logPanel}
            activeDiff={tree.activeDiff}
            focusReviewDiff={focusReviewDiff}
            sessionWidth={pane()}
          />
        </Show>
      </div>

      <TerminalPanel />
    </div>
  )
}
