import { batch, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssistantMessage, Message, Part, SessionStatus } from "@open-agent-harness/sdk/v2/client"
import { same } from "@/utils/same"

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  session?: Accessor<boolean>
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
  logs?: Accessor<boolean>
  files?: Accessor<boolean>
  graph?: Accessor<boolean>
}

export const getSessionKey = (dir: string | undefined, id: string | undefined) => `${dir ?? ""}${id ? `/${id}` : ""}`

export const isSessionBusy = (status: SessionStatus | undefined, _messages?: Message[]) => {
  const type = status?.type ?? "idle"
  return type === "running" || type === "retry" || type === "rate_limited" || type === "waiting_permission" || type === "waiting_user" || type === "waiting_child"
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const turn = (input: Message | undefined) => {
  if (!input || input.role !== "user") return
  const metadata = (input as { metadata?: unknown }).metadata
  if (!record(metadata)) return
  const value = metadata.turn
  if (!record(value)) return
  return value
}

export const turnDone = (messages: Message[], id: string, status: SessionStatus | undefined) => {
  const type = status?.type ?? "idle"
  const idx = messages.findIndex((item) => item.id === id)
  if (idx === -1) return false
  const state = turn(messages[idx])
  if (state?.status === "done") return true
  if (type !== "idle" && type !== "completed") return false
  const list: AssistantMessage[] = []
  for (let i = idx + 1; i < messages.length; i++) {
    const item = messages[i]
    if (!item) continue
    if (item.role === "user") break
    if (item.role === "assistant" && item.parentID === id) list.push(item)
  }
  const last = list.at(-1)
  if (!last) return false
  return typeof last.time.completed === "number" && !last.error
}

export const deriveTurnStats = (messages: Message[], id: string, parts: Record<string, Part[] | undefined>) => {
  const idx = messages.findIndex((item) => item.id === id)
  if (idx === -1) return {}
  let tools = 0
  let actions = 0
  for (let i = idx + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role === "user") break
    if (msg.role !== "assistant" || msg.parentID !== id) continue
    for (const part of parts[msg.id] ?? []) {
      if (part.type === "tool") tools++
      if (part.type === "text" && record(part.metadata) && part.metadata.protocol) actions++
    }
  }
  return {
    actions: actions > 0 ? actions : undefined,
    tools: tools > 0 ? tools : undefined,
  }
}

export const createSessionTabs = (input: TabsInput) => {
  const session = input.session ?? (() => false)
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const logs = input.logs ?? (() => false)
  const files = input.files ?? (() => false)
  const graph = input.graph ?? (() => false)
  const contextOpen = createMemo(() => input.tabs().active() === "context" || input.tabs().all().includes("context"))
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input
        .tabs()
        .all()
        .flatMap((tab) => {
          if (tab === "session" || tab === "context" || tab === "review" || tab === "logs" || tab === "graph" || tab === "workflow" || tab === "protocol") return []
          if ((tab === "changes" || tab === "all") && files()) return []
          const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
          if (seen.has(value)) return []
          seen.add(value)
          return [value]
        })
    },
    emptyTabs,
    { equals: same },
  )
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "session" && session()) return active
    if (active === "context") return active
    if (active === "review" && review()) return active
    if (active === "logs" && logs()) return active
    if (active === "graph" && graph()) return active
    if ((active === "workflow" || active === "protocol") && graph()) return "graph"
    if ((active === "changes" || active === "all") && files()) return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)

    if (session()) return "session"
    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (graph()) return "graph"
    if (review() && hasReview()) return "review"
    if (logs()) return "logs"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })
  const closableTab = createMemo(() => {
    const active = activeTab()
    if (active === "context") return active
    if (!openedTabs().includes(active)) return
    return active
  })

  return {
    contextOpen,
    openedTabs,
    activeTab,
    activeFileTab,
    closableTab,
  }
}

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) maybePromise.then(open)
      else open()
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  openReviewPanel: () => void
  setActive: (tab: string) => void
}) => {
  return (value: string) => {
    const next = input.normalizeTab(value)
    input.openTab(next)

    const path = input.pathFromTab(next)
    if (!path) return

    input.loadFile(path)
    input.openReviewPanel()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let t: number | undefined

  const stop = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
    onCleanup(() => {
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
    })
  })

  onCleanup(() => {
    if (t !== undefined) clearTimeout(t)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      t = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>
