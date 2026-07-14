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

export const automaticResumeMode = () => "auto" as const

export const isSessionBusy = (status: SessionStatus | undefined, _messages?: Message[]) => {
  const type = status?.type ?? "idle"
  return type === "running" || type === "retry" || type === "rate_limited" || type === "waiting_permission" || type === "waiting_user" || type === "waiting_child"
}

export type SessionLiveStatus = {
  label: string
  description: string
  tone: "info" | "warning" | "danger" | "success"
  metrics?: string[]
}

export type SessionResumePrompt = {
  label: string
  description: string
  action: string
}

const liveStatus = (label: string, description: string, tone: SessionLiveStatus["tone"] = "info", metrics?: string[]) => ({
  label,
  description,
  tone,
  metrics: metrics?.length ? metrics : undefined,
})

const restorable = new Set<SessionStatus["type"]>(["aborted", "paused", "failed", "timeout", "error"])

export const resumePrompt = (status: SessionStatus | undefined): SessionResumePrompt | undefined => {
  if (status?.type === "interrupted") {
    return {
      label: "会话中断",
      description: status.message || "系统或进程中断了这个会话，确认后从可恢复状态继续。",
      action: "继续",
    }
  }
  if (!status || !restorable.has(status.type)) return undefined
  const msg = "message" in status ? status.message : undefined
  return {
    label: "会话异常中断",
    description: msg || "会话停在异常状态，确认后从可恢复状态继续。",
    action: "继续",
  }
}

const encoder = new TextEncoder()

const num = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : undefined)

const bytes = (input: string | undefined) => (input ? encoder.encode(input).length : 0)

const size = (input: number) => {
  if (input < 1024) return `${input} B`
  if (input < 1024 * 1024) return `${(input / 1024).toFixed(1).replace(/\.0$/, "")} KB`
  return `${(input / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

const period = (input: number) => {
  const ms = Math.max(0, Math.round(input))
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return sec ? `${min}m ${sec}s` : `${min}m`
}

const metric = (items: Array<string | undefined>) => items.filter((item): item is string => !!item)

const elapsed = (start: number | undefined, end: number | undefined, now: number) => {
  if (start === undefined) return
  return `用时 ${period((end ?? now) - start)}`
}

const pendingAssistant = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && typeof msg.time.completed !== "number") return msg
  }
}

const lastUser = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") return msg
  }
}

const runningTool = (part: Part): part is Extract<Part, { type: "tool" }> =>
  part.type === "tool" && (part.state.status === "running" || part.state.status === "pending")

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

const start = (input: Message | undefined) => {
  if (!input) return
  const value = turn(input)
  const time = record(value?.time) ? value.time : undefined
  return num(time?.started) ?? num(time?.queued) ?? input.time.created
}

const output = (part: Part) => {
  if (part.type === "text" || part.type === "reasoning") return bytes(part.text)
  if (part.type === "tool" && part.state.status === "completed") return bytes(part.state.output)
  if (part.type === "tool" && part.state.status === "error") return bytes(part.state.error)
  return 0
}

const request = (part: Part) => {
  if (part.type === "text") return bytes(part.text)
  if (part.type === "file") return bytes(part.source?.text.value)
  if (part.type === "agent") return bytes(part.source?.value)
  if (part.type === "subtask") return bytes(part.prompt) + bytes(part.description)
  return 0
}

const begun = (part: Part) => {
  if (part.type === "text") return num(part.time?.start)
  if (part.type === "reasoning") return part.time.start
  if (part.type === "tool" && part.state.status !== "pending") return part.state.time.start
}

const ended = (part: Part) => {
  if (part.type === "text") return num(part.time?.end)
  if (part.type === "reasoning") return num(part.time.end)
  if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) return part.state.time.end
}

const first = (parts: Part[], fallback: number | undefined) =>
  parts.reduce((best, part) => {
    const value = begun(part)
    if (value === undefined) return best
    if (best === undefined) return value
    return Math.min(best, value)
  }, fallback)

const last = (parts: Part[]) =>
  parts.reduce((best, part) => {
    const value = ended(part)
    if (value === undefined) return best
    if (best === undefined) return value
    return Math.max(best, value)
  }, undefined as number | undefined)

export const deriveSessionLiveStatus = (input: {
  status: SessionStatus | undefined
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  now?: number
}): SessionLiveStatus | undefined => {
  const status = input.status?.type ?? "idle"
  const now = input.now ?? Date.now()
  const user = lastUser(input.messages)
  const live = () => metric([elapsed(start(user), undefined, now)])
  if (status === "idle" || status === "completed" || status === "terminal_reply" || status === "user_completed" || status === "archived") return undefined
  if (status === "waiting_permission") {
    return liveStatus("等待权限确认", "工具调用已暂停，正在等待权限选择。", "warning", live())
  }
  if (status === "waiting_user") {
    return liveStatus("等待用户确认", "模型请求已暂停，正在等待你的回复。", "warning", live())
  }
  if (input.status?.type === "waiting_child") {
    return liveStatus("等待子会话", input.status.message || "父会话已暂停，正在等待子会话完成。", "warning", live())
  }
  if (input.status?.type === "rate_limited") {
    const scope = input.status.scope === "model" ? "模型" : input.status.scope === "provider" ? "服务商" : "智能体"
    const reset =
      input.status.reset && input.status.reset > Date.now()
        ? `，预计 ${Math.ceil((input.status.reset - Date.now()) / 1000)} 秒后释放`
        : ""
    if (input.status.kind === "rpm") {
      return liveStatus(
        "请求频率已满",
        `${scope}最近一分钟已达 ${input.status.limit} 次请求，队列中 ${input.status.queued} 个请求${reset}。`,
        "warning",
        live(),
      )
    }
    return liveStatus(
      "并发额度已满",
      `${scope}并发 ${input.status.active}/${input.status.limit}，队列中 ${input.status.queued} 个请求，${input.status.providerID}/${input.status.modelID} 正在等待可用额度。`,
      "warning",
      live(),
    )
  }
  if (input.status?.type === "retry") {
    return liveStatus("准备重试", `${input.status.message}，第 ${input.status.attempt} 次重试已排队。`, "warning", live())
  }
  if (input.status?.type === "paused") return liveStatus("已暂停", input.status.message || "会话运行已暂停。", "warning", live())
  if (input.status?.type === "aborting") return liveStatus("正在停止", input.status.message || "正在停止当前会话。", "warning", live())
  if (input.status?.type === "error") return liveStatus("运行出错", input.status.message, "danger", live())
  if (input.status?.type === "timeout") return liveStatus("运行超时", input.status.message, "danger", live())
  if (input.status?.type === "failed") return liveStatus("运行失败", input.status.message || "会话运行失败。", "danger", live())
  if (input.status?.type === "blocked") return liveStatus("已阻塞", input.status.message || "会话需要外部输入后才能继续。", "warning", live())
  if (input.status?.type === "queued") return liveStatus("请求排队中", "请求已进入队列，等待运行。", "info", live())
  if (input.status?.type === "starting") return liveStatus("请求发送中", "正在准备模型请求。", "info", live())
  if (status !== "running") return undefined

  const state = turn(user)
  if (state?.status === "done") return undefined
  if (state?.status === "queued") {
    const time = record(state.time) ? num(state.time.queued) : undefined
    return liveStatus(
      "请求排队中",
      "请求已持久化，等待当前运行结束后消费。",
      "info",
      metric([elapsed(time, undefined, now)]),
    )
  }

  const msg = pendingAssistant(input.messages)
  if (msg) {
    const parts = input.parts[msg.id] ?? []
    const received = parts.reduce((sum, part) => sum + output(part), 0)
    const info = (start: number | undefined, end?: number) =>
      metric([elapsed(start, end, now), received > 0 ? `已接收 ${size(received)}` : undefined])
    const tool = parts.findLast(runningTool)
    if (tool) {
      const title = "title" in tool.state && typeof tool.state.title === "string" ? `：${tool.state.title}` : ""
      return liveStatus("工具调用中", `正在执行 ${tool.tool}${title}`, "info", metric([elapsed(begun(tool), undefined, now)]))
    }
    if (parts.findLast((part) => part.type === "text" && part.text.trim())) {
      return liveStatus("文本回复中", "模型正在生成可见回复。", "info", info(first(parts, undefined) ?? msg.time.created, last(parts)))
    }
    if (parts.findLast((part) => part.type === "reasoning" && part.text.trim())) {
      return liveStatus("思考中", "模型正在生成推理内容。", "info", info(first(parts, undefined) ?? msg.time.created, last(parts)))
    }
    return liveStatus("响应中", "模型响应已开始，正在接收内容。", "info", info(msg.time.created))
  }

  if (user) {
    const sent = (input.parts[user.id] ?? []).reduce((sum, part) => sum + request(part), 0)
    return liveStatus(
      "请求已发出",
      "用户消息已进入会话，正在等待模型开始响应。",
      "info",
      metric([elapsed(start(user), undefined, now), sent > 0 ? `已发送 ${size(sent)}` : undefined]),
    )
  }
  if (status === "running") return liveStatus("响应中", "模型请求正在运行。", "info", live())
  return undefined
}

export const turnDone = (messages: Message[], id: string, status: SessionStatus | undefined) => {
  const type = status?.type ?? "idle"
  const idx = messages.findIndex((item) => item.id === id)
  if (idx === -1) return false
  const state = turn(messages[idx])
  if (state?.status === "done") return true
  if (type !== "idle" && type !== "completed" && type !== "terminal_reply") return false
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
