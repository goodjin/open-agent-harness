import { For, createEffect, createMemo, createSignal, on, onCleanup, Show, Index, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Button } from "@open-agent-harness/ui/button"
import { FileIcon } from "@open-agent-harness/ui/file-icon"
import { Icon } from "@open-agent-harness/ui/icon"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { DropdownMenu } from "@open-agent-harness/ui/dropdown-menu"
import { Dialog } from "@open-agent-harness/ui/dialog"
import { InlineInput } from "@open-agent-harness/ui/inline-input"
import { Spinner } from "@open-agent-harness/ui/spinner"
import { SessionTurn, SessionTurnDiffs, turnAssistants, type SessionTurnFilter } from "@open-agent-harness/ui/session-turn"
import { Markdown } from "@open-agent-harness/ui/markdown"
import { ScrollView } from "@open-agent-harness/ui/scroll-view"
import { TextField } from "@open-agent-harness/ui/text-field"
import type {
  AssistantMessage,
  Message as MessageType,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  TextPart,
  UserMessage,
} from "@open-agent-harness/sdk/v2"
import { showToast } from "@open-agent-harness/ui/toast"
import { Binary } from "@open-agent-harness/util/binary"
import { getFilename } from "@open-agent-harness/util/path"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { deriveTurnStats, isSessionBusy, turnDone } from "@/pages/session/helpers"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { lastAssistant, lastUser, modelName, statusName, totals } from "@/pages/session/session-insight-banner-helpers"
import {
  confirmationKey,
  protocolConfirmationRequest,
  questionConfirmationKey,
  visibleConfirmations,
} from "@/pages/session/session-confirmation-match"
import { delegationProgress, pendingDelegation, turn, type DelegationItem } from "@/pages/session/session-delegations"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }

const completeLabel = "本轮执行完毕"
const delegationLabel = "等待子会话执行任务中"
const restorable = new Set(["interrupted"])
const live = new Set(["running", "starting", "queued", "retry", "rate_limited", "waiting_permission", "waiting_user", "waiting_child"])
const done = new Set(["completed", "user_completed", "archived"])
const fallbackable = new Set(["failed", "blocked"])

const text = (input: unknown) => (typeof input === "string" ? input : undefined)

type ConfirmStatus = "pending" | "confirmed" | "cancelled"
type FallbackStatus = "success" | "failure" | "reply"

type ConfirmRecord = {
  action_id: string
  action_title?: string
  message_id: string
  plan?: string
  run_id: string
  status: ConfirmStatus
  updated_at?: number
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const status = (input: unknown): ConfirmStatus | undefined => {
  if (input === "pending" || input === "confirmed" || input === "cancelled") return input
  return undefined
}

const confirmItem = (input: unknown): ConfirmRecord | undefined => {
  if (!record(input)) return
  const state = status(input.status)
  const action = text(input.action_id)
  const message = text(input.message_id)
  const run = text(input.run_id)
  if (!state || !action || !message || !run) return
  return {
    action_id: action,
    action_title: text(input.action_title),
    message_id: message,
    plan: text(input.plan),
    run_id: run,
    status: state,
    updated_at: typeof input.updated_at === "number" ? input.updated_at : undefined,
  }
}

const turnInfo = (input: UserMessage | undefined) => {
  const metadata = input?.metadata
  if (!record(metadata)) return
  const turn = metadata.turn
  if (!record(turn)) return
  return turn
}

const turnStats = (input: UserMessage | undefined) => {
  const stats = turnInfo(input)?.stats
  if (!record(stats)) return {}
  const num = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined)
  return {
    actions: num(stats.actions),
    children: num(stats.children),
    confirmations: num(stats.confirmations),
    tools: num(stats.tools),
  }
}

const confirmations = (input: unknown, messageID: string, messages: MessageType[]) => {
  if (!record(input)) return []
  const protocol = input.protocol
  if (!record(protocol)) return []
  const vals = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
  return vals
    .map(confirmItem)
    .filter((item): item is ConfirmRecord => !!item && turn(messages, messageID, item.message_id))
    .sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
}

const within = (session: Session[], root: string, target: string): boolean => {
  if (root === target) return true
  const map = new Map(session.map((item) => [item.id, item.parentID]))
  let id: string | undefined = target
  while (id) {
    const parent = map.get(id)
    if (!parent) return false
    if (parent === root) return true
    id = parent
  }
  return false
}

const match = (
  input: { sessionID: string; tool?: { messageID: string } } | undefined,
  messageID: string,
  sessionID: string | undefined,
  children: { id: string }[],
  session: Session[],
  messages: MessageType[],
) => {
  if (!input || !sessionID) return false
  if (input.sessionID === sessionID) return !input.tool || turn(messages, messageID, input.tool.messageID)
  return children.some((item) => within(session, item.id, input.sessionID))
}

const dot = (type: string) => {
  if (type === "waiting_user" || type === "waiting_permission" || type === "waiting_child" || type === "rate_limited" || type === "blocked")
    return "bg-icon-warning-base"
  if (live.has(type)) return "bg-icon-info-base"
  if (type === "completed" || type === "user_completed") return "bg-icon-success-base"
  if (type === "idle") return "bg-icon-weak-base"
  return "bg-icon-critical-base"
}

const label = (type: string) => (type === "user_completed" ? "用户标记完成" : type)

const safe = (input: unknown) => {
  if (!record(input)) return false
  return input.type === "error" && input.reason === "output_safety" && input.recoverable === true
}

type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  retry?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  context?: (input: { sessionID: string; messageID: string; text: string }) => Promise<void> | void
  continue?: (input: { sessionID: string; messageID: string; text: string }) => Promise<void> | void
  prompt?: (input: { sessionID: string; messageID: string; text: string }) => Promise<void> | void
}

type Requests = {
  question?: QuestionRequest
  permission?: PermissionRequest
  responding: boolean
  submit: () => void
  decide: (response: "once" | "always" | "reject") => void
}

function SessionConfirmationCard(props: {
  item: ConfirmRecord
  request?: QuestionRequest
  submit: () => void
}) {
  const [open, setOpen] = createSignal(props.item.status === "pending")
  const title = createMemo(() => {
    if (props.item.status === "confirmed") return "已确认"
    if (props.item.status === "cancelled") return "已取消"
    return "需要确认"
  })

  createEffect(() => {
    if (props.item.status !== "pending") setOpen(false)
  })

  return (
    <div class="px-6 md:px-8 pt-4">
      <div data-component="session-request-card" class="rounded-md border border-border-weak-base bg-background-base overflow-hidden">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="min-w-0 flex flex-col gap-0.5">
            <span class="text-12-medium text-text-strong">{title()}</span>
            <span class="truncate text-11-regular text-text-weak">
              {props.item.action_title ?? props.item.action_id}
            </span>
          </span>
          <span class="inline-flex shrink-0 items-center gap-2">
            <span
              class="rounded-sm border px-1.5 py-0.5 text-10-medium"
              classList={{
                "border-border-weak-base text-text-weak": props.item.status === "pending",
                "border-icon-success-base/40 text-icon-success-base": props.item.status === "confirmed",
                "border-icon-warning-base/40 text-icon-warning-base": props.item.status === "cancelled",
              }}
            >
              {props.item.status}
            </span>
            <span class="inline-flex text-icon-weak transition-transform" classList={{ "-rotate-90": !open() }}>
              <Icon name="chevron-down" size="small" />
            </span>
          </span>
        </button>
        <Show when={open()}>
          <div class="border-t border-border-weaker-base p-2.5">
            <Show
              when={props.item.status === "pending" ? props.request : undefined}
              keyed
              fallback={
                <div
                  data-scrollable
                  class="max-h-[42vh] overflow-auto rounded-sm bg-background-strong p-3 text-12-regular text-text-strong"
                >
                  <Markdown text={props.item.plan || "No plan text recorded."} />
                </div>
              }
            >
              {(req) => <SessionQuestionDock request={req} onSubmit={props.submit} />}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

function SessionOutputSafetyCard(props: {
  sessionID: string
  messageID: string
  status: unknown
  onContinue?: UserActions["continue"]
}) {
  const [busy, setBusy] = createSignal(false)
  const msg = createMemo(() => {
    if (!record(props.status)) return "Provider blocked model output because it matched an output safety policy."
    return text(props.status.message) ?? "Provider blocked model output because it matched an output safety policy."
  })
  const prompt = [
    "继续当前会话，不要复述历史上下文。",
    "上一轮 provider 在输出阶段触发安全拦截。",
    "请用更短、更直接的表述继续未完成工作；如果需要协议输出，只输出下一步必要的 Agent Protocol package。",
  ].join("\n")
  const cont = async () => {
    if (!props.onContinue || busy()) return
    setBusy(true)
    try {
      await props.onContinue({ sessionID: props.sessionID, messageID: props.messageID, text: prompt })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="px-6 md:px-8 pt-4">
      <div class="rounded-md border border-icon-warning-base/40 bg-background-base p-3">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="text-12-medium text-text-strong">输出被供应商安全策略拦截</div>
            <div class="mt-1 text-12-regular text-text-weak">{msg()}</div>
          </div>
          <Button variant="secondary" size="small" class="h-7 px-2 shrink-0" disabled={busy()} onClick={cont}>
            继续进行
          </Button>
        </div>
      </div>
    </div>
  )
}

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  request?: Requests
  scroll: { overflow: boolean; bottom: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  anchor: (id: string) => string
  filter: SessionTurnFilter
  onFilterChange: (filter: SessionTurnFilter) => void
  onJumpPreviousUserInput: () => void
  onJumpNextUserInput: () => void
  canJumpUserInput: boolean
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionLayout()
  const platform = usePlatform()

  const sessionID = createMemo(() => params.id)
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const pending = createMemo(() =>
    sessionMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const usage = createMemo(() => totals(sessionMessages()))
  const num = createMemo(() => new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }))
  const usd = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }))
  const model = createMemo(() =>
    modelName({
      user: lastUser(sessionMessages()),
      assistant: lastAssistant(sessionMessages()),
      providers: sync.data.provider.all,
    }),
  )
  const state = createMemo(() => statusName(sessionStatus()))
  const token = createMemo(() => {
    const total = usage().input + usage().output + usage().reasoning + usage().cache
    return `${num().format(total)} tokens`
  })
  const working = createMemo(() => !!pending() || isSessionBusy(sessionStatus()))
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))
  const turnMatches = (id: string) => {
    if (props.filter === "all" || props.filter === "input") return true
    const messages = sessionMessages()
    for (const item of turnAssistants(messages, id)) {
      const parts = sync.data.part[item.id] ?? []
      if (props.filter === "thinking" && parts.some((part) => part.type === "reasoning")) return true
      if (props.filter === "output" && parts.some((part) => part.type === "text")) return true
      if (props.filter === "tool" && parts.some((part) => part.type === "tool")) return true
    }

    return false
  }
  const turns = createMemo(() => {
    const id = sessionID()
    const revert = id ? sync.session.get(id)?.revert?.messageID : undefined
    return sessionMessages().filter(
      (message): message is UserMessage => message.role === "user" && (!revert || message.id < revert),
    )
  })
  const rendered = createMemo(() => props.renderedUserMessages.filter((message) => turnMatches(message.id)))
  const ordinal = (id: string) => {
    const idx = turns().findIndex((message) => message.id === id)
    if (idx >= 0) return idx + 1
    return props.turnStart + rendered().findIndex((message) => message.id === id) + 1
  }

  const [slot, setSlot] = createStore({
    open: false,
    show: false,
    fade: false,
  })

  let f: number | undefined
  const clear = () => {
    if (f !== undefined) window.clearTimeout(f)
    f = undefined
  }

  onCleanup(clear)
  createEffect(
    on(
      working,
      (on, prev) => {
        clear()
        if (on) {
          setSlot({ open: true, show: true, fade: false })
          return
        }
        if (prev) {
          setSlot({ open: false, show: true, fade: true })
          f = window.setTimeout(() => setSlot({ show: false, fade: false }), 260)
          return
        }
        setSlot({ open: false, show: false, fade: false })
      },
      { defer: true },
    ),
  )
  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (live.has(status.type)) {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const shareUrl = createMemo(() => info()?.share?.url)
  const shareEnabled = createMemo(() => sync.data.config.share !== "disabled")
  const parentID = createMemo(() => info()?.parentID)
  const filterOptions: { id: SessionTurnFilter; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "thinking", label: "思考" },
    { id: "input", label: "输入" },
    { id: "output", label: "输出" },
    { id: "tool", label: "工具调用" },
  ]
  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    saving: false,
    menuOpen: false,
    pendingRename: false,
    pendingShare: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [share, setShare] = createStore({
    open: false,
    dismiss: null as "escape" | "outside" | null,
  })

  let more: HTMLButtonElement | undefined

  const [req, setReq] = createStore({ share: false, status: false, unshare: false })
  const [op, setOp] = createStore({ child: {} as Record<string, string | undefined> })

  const shareSession = () => {
    const id = sessionID()
    if (!id || req.share) return
    if (!shareEnabled()) return
    setReq("share", true)
    globalSDK.client.session
      .share({ sessionID: id, directory: sdk.directory })
      .catch((err: unknown) => {
        console.error("Failed to share session", err)
      })
      .finally(() => {
        setReq("share", false)
      })
  }

  const unshareSession = () => {
    const id = sessionID()
    if (!id || req.unshare) return
    if (!shareEnabled()) return
    setReq("unshare", true)
    globalSDK.client.session
      .unshare({ sessionID: id, directory: sdk.directory })
      .catch((err: unknown) => {
        console.error("Failed to unshare session", err)
      })
      .finally(() => {
        setReq("unshare", false)
      })
  }

  const viewShare = () => {
    const url = shareUrl()
    if (!url) return
    platform.openLink(url)
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          saving: false,
          menuOpen: false,
          pendingRename: false,
          pendingShare: false,
        }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID()) return
    setTitle({ editing: true, draft: titleValue() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (title.saving) return
    setTitle({ editing: false, saving: false })
  }

  const copyTitle = () => {
    const value = titleValue() ?? sessionID()
    if (!value) return
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: value,
        })
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const saveTitleEditor = async () => {
    const id = sessionID()
    if (!id) return
    if (title.saving) return

    const next = title.draft.trim()
    if (!next || next === (titleValue() ?? "")) {
      setTitle({ editing: false, saving: false })
      return
    }

    setTitle("saving", true)
    await sdk.client.session
      .update({ sessionID: id, title: next })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === id)
            if (index !== -1) draft.session[index].title = next
          }),
        )
        setTitle({ editing: false, saving: false })
      })
      .catch((err) => {
        setTitle("saving", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  const post = (id: string, path: string, body: Record<string, unknown>) => {
    setOp("child", id, path)
    return sdk
      .request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: sdk.directory,
          ids: [id],
          source_session: sessionID(),
          ...body,
        }),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        await sync.session.sync(id, { force: true }).catch(() => undefined)
        const current = sessionID()
        if (current) await sync.session.sync(current, { force: true }).catch(() => undefined)
      })
      .finally(() => {
        setOp("child", id, undefined)
      })
  }

  const pause = (id: string) =>
    post(id, "/session/tree/abort", { reason: "Paused from session timeline" }).catch((err: unknown) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      }),
    )

  const resume = (id: string) =>
    post(id, "/session/tree/resume", { mode: "restore" }).catch((err: unknown) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      }),
    )

  const mark = (id: string, reason = "Marked complete from session timeline") => {
    const current = sessionID()
    if (current === id) setReq("status", true)
    else setOp("child", id, "user_completed")
    return sdk
      .request(`/session/${id}/status/user-completed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        await sync.session.sync(id, { force: true }).catch(() => undefined)
        if (current && current !== id) await sync.session.sync(current, { force: true }).catch(() => undefined)
      })
      .catch((err: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        }),
      )
      .finally(() => {
        if (current === id) setReq("status", false)
        else setOp("child", id, undefined)
      })
  }

  const submit = (run: string) => {
    const id = sessionID()
    if (!id) return
    const key = `submit:${run}`
    setOp("child", key, "submit")
    return sdk
      .request(`/session/${id}/delegations/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: sdk.directory,
          force: true,
          run_id: run,
        }),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        await sync.session.sync(id, { force: true }).catch(() => undefined)
      })
      .catch((err: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        }),
      )
      .finally(() => {
        setOp("child", key, undefined)
      })
  }

  const cancelRun = (run: string) => {
    const id = sessionID()
    if (!id) return
    const key = `cancel:${run}`
    setOp("child", key, "cancel")
    return sdk
      .request(`/session/${id}/delegations/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: sdk.directory,
          reason: "User cancelled delegated child sessions from parent timeline.",
          run_id: run,
        }),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        await sync.session.sync(id, { force: true }).catch(() => undefined)
      })
      .catch((err: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        }),
      )
      .finally(() => {
        setOp("child", key, undefined)
      })
  }

  const openFallback = (id: string) => {
    setOp("child", id, "fallback")
    return sdk
      .request(`/session/${id}/delegations/fallback-preview`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        const data = (await res.json()) as { messageID?: string; text: string }
        dialog.show(() => <DialogConfirmFallback sessionID={id} messageID={data.messageID} text={data.text} />)
      })
      .catch((err: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        }),
      )
      .finally(() => {
        setOp("child", id, undefined)
      })
  }

  function DialogConfirmFallback(props: { messageID?: string; sessionID: string; text: string }) {
    const [value, setValue] = createSignal(props.text)
    const [state, setState] = createSignal<FallbackStatus>("success")
    const [saving, setSaving] = createSignal(false)
    const submit = () => {
      const result = value().trim()
      if (!result || saving()) return
      setSaving(true)
      setOp("child", props.sessionID, "confirm_fallback")
      sdk
        .request(`/session/${props.sessionID}/delegations/confirm-fallback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            edited: result !== props.text.trim(),
            original_message_id: props.messageID,
            result,
            status: state(),
          }),
        })
        .then(async (res) => {
          if (!res.ok) throw new Error(await res.text())
          await sync.session.sync(props.sessionID, { force: true }).catch(() => undefined)
          const current = sessionID()
          if (current && current !== props.sessionID) await sync.session.sync(current, { force: true }).catch(() => undefined)
          dialog.close()
        })
        .catch((err: unknown) =>
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: errorMessage(err),
          }),
        )
        .finally(() => {
          setSaving(false)
          setOp("child", props.sessionID, undefined)
        })
    }

    return (
      <Dialog title="确认子会话结果" fit>
        <div class="flex w-[min(760px,calc(100vw-32px))] max-w-full flex-col gap-4 px-6 pb-4">
          <div class="flex flex-col gap-1 text-13-regular text-text-weak">
            <span>大模型没有成功调用 ActionResult。下面内容会作为用户确认过的 fallback 结果提交给父会话。</span>
            <span>提交后子会话状态会标记为用户确认完成。</span>
          </div>
          <textarea
            class="h-[360px] min-h-[220px] w-full resize-y rounded-md border border-border-weak-base bg-background-base px-3 py-2 font-mono text-12-regular text-text-strong outline-none focus:border-border-strong-base"
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
          />
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="flex items-center gap-2 text-12-regular text-text-weak">
              <span>结果状态</span>
              <select
                class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong outline-none"
                value={state()}
                onChange={(event) => setState(event.currentTarget.value as FallbackStatus)}
              >
                <option value="success">成功</option>
                <option value="reply">需要父会话继续处理</option>
                <option value="failure">失败</option>
              </select>
            </label>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button variant="primary" size="large" disabled={saving() || value().trim().length === 0} onClick={submit}>
                确认提交
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(() => sync.session.get(props.sessionID)?.title ?? language.t("command.session.new"))
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && !props.scroll.bottom,
            "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || props.scroll.bottom,
          }}
        >
          <button
            class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border border-border-base shadow-sm text-text-base hover:bg-background-stronger transition-colors"
            onClick={props.onResumeScroll}
          >
            <Icon name="arrow-down-to-line" />
          </button>
        </div>
        <Show when={props.canJumpUserInput}>
          <div class="absolute right-3 top-20 z-40 flex flex-col gap-2">
            <IconButton
              icon="arrow-up"
              variant="ghost"
              class="size-8 rounded-full border border-border-weak-base bg-background-base shadow-sm"
              aria-label="跳到上一次用户输入"
              onClick={props.onJumpPreviousUserInput}
            />
            <Show when={!props.scroll.bottom}>
              <IconButton
                icon="arrow-down-to-line"
                variant="ghost"
                class="size-8 rounded-full border border-border-weak-base bg-background-base shadow-sm"
                aria-label="跳到下一次用户输入"
                onClick={props.onJumpNextUserInput}
              />
            </Show>
          </div>
        </Show>
        <ScrollView
          viewportRef={props.setScrollRef}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            if (!props.hasScrollGesture()) return
            props.onUserScroll()
            props.onAutoScrollHandleScroll()
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          style={{
            "--session-title-height": "80px",
            "--sticky-accordion-top": "88px",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <div
              data-session-title
              classList={{
                "sticky top-0 z-30 border-b border-border-weaker-base bg-background-stronger": true,
                "w-full": true,
                "pb-2": true,
                "pl-2 pr-3 md:pl-4 md:pr-3": true,
                "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
              }}
            >
              <div class="h-12 w-full flex items-center justify-between gap-2">
                <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                  <Show when={parentID()}>
                    <IconButton
                      tabIndex={-1}
                      icon="arrow-left"
                      variant="ghost"
                      onClick={navigateParent}
                      aria-label={language.t("common.goBack")}
                    />
                  </Show>
                  <div class="flex items-center min-w-0 grow-1">
                    <div
                      class="shrink-0 flex items-center justify-center overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                      style={{
                        width: slot.open ? "16px" : "0px",
                        "margin-right": slot.open ? "8px" : "0px",
                      }}
                      aria-hidden="true"
                    >
                      <Show when={slot.show}>
                        <div
                          class="transition-opacity duration-200 ease-out"
                          classList={{
                            "opacity-0": slot.fade,
                          }}
                        >
                          <Spinner class="size-4" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
                        </div>
                      </Show>
                    </div>
                    <Show when={titleValue() || title.editing}>
                      <Show
                        when={title.editing}
                        fallback={
                          <h1
                            class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                            onDblClick={openTitleEditor}
                          >
                            {titleValue()}
                          </h1>
                        }
                      >
                        <InlineInput
                          ref={(el) => {
                            titleRef = el
                          }}
                          value={title.draft}
                          disabled={title.saving}
                          class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px]"
                          style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                          onInput={(event) => setTitle("draft", event.currentTarget.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation()
                            if (event.key === "Enter") {
                              event.preventDefault()
                              void saveTitleEditor()
                              return
                            }
                            if (event.key === "Escape") {
                              event.preventDefault()
                              closeTitleEditor()
                            }
                          }}
                          onBlur={closeTitleEditor}
                        />
                      </Show>
                    </Show>
                  </div>
                </div>
                <Show when={sessionID()}>
                  {(id) => (
                    <div class="shrink-0 flex items-center gap-3">
                      <SessionContextUsage placement="bottom" />
                      <DropdownMenu
                        gutter={4}
                        placement="bottom-end"
                        open={title.menuOpen}
                        onOpenChange={(open) => {
                          setTitle("menuOpen", open)
                          if (open) return
                        }}
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                          classList={{
                            "bg-surface-base-active": share.open || title.pendingShare,
                          }}
                          aria-label={language.t("common.moreOptions")}
                          aria-expanded={title.menuOpen || share.open || title.pendingShare}
                          ref={(el: HTMLButtonElement) => {
                            more = el
                          }}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            style={{ "min-width": "104px" }}
                            onCloseAutoFocus={(event) => {
                              if (title.pendingRename) {
                                event.preventDefault()
                                setTitle("pendingRename", false)
                                openTitleEditor()
                                return
                              }
                              if (title.pendingShare) {
                                event.preventDefault()
                                requestAnimationFrame(() => {
                                  setShare({ open: true, dismiss: null })
                                  setTitle("pendingShare", false)
                                })
                              }
                            }}
                          >
                            <DropdownMenu.Item
                              onSelect={() => {
                                setTitle("pendingRename", true)
                                setTitle("menuOpen", false)
                              }}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              onSelect={() => {
                                setTitle("menuOpen", false)
                                copyTitle()
                              }}
                            >
                              <div class="flex size-5 shrink-0 items-center justify-center">
                                <Icon name="copy" size="small" class="text-icon-weak" />
                              </div>
                              <DropdownMenu.ItemLabel>{language.t("session.copyName")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <Show when={shareEnabled()}>
                              <DropdownMenu.Item
                                onSelect={() => {
                                  setTitle({ pendingShare: true, menuOpen: false })
                                }}
                              >
                                <DropdownMenu.ItemLabel>
                                  {language.t("session.share.action.share")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={!done.has(sessionStatus().type)}>
                              <DropdownMenu.Item
                                onSelect={() => {
                                  setTitle("menuOpen", false)
                                  void mark(id(), "User marked the session complete.")
                                }}
                                disabled={req.status}
                              >
                                <DropdownMenu.ItemLabel>标记为用户完成</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <DropdownMenu.Item onSelect={() => void archiveSession(id())}>
                              <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id()} />)}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>

                      <KobaltePopover
                        open={share.open}
                        anchorRef={() => more}
                        placement="bottom-end"
                        gutter={4}
                        modal={false}
                        onOpenChange={(open) => {
                          if (open) setShare("dismiss", null)
                          setShare("open", open)
                        }}
                      >
                        <KobaltePopover.Portal>
                          <KobaltePopover.Content
                            data-component="popover-content"
                            style={{ "min-width": "320px" }}
                            onEscapeKeyDown={(event) => {
                              setShare({ dismiss: "escape", open: false })
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                            onPointerDownOutside={() => {
                              setShare({ dismiss: "outside", open: false })
                            }}
                            onFocusOutside={() => {
                              setShare({ dismiss: "outside", open: false })
                            }}
                            onCloseAutoFocus={(event) => {
                              if (share.dismiss === "outside") event.preventDefault()
                              setShare("dismiss", null)
                            }}
                          >
                            <div class="flex flex-col p-3">
                              <div class="flex flex-col gap-1">
                                <div class="text-13-medium text-text-strong">
                                  {language.t("session.share.popover.title")}
                                </div>
                                <div class="text-12-regular text-text-weak">
                                  {shareUrl()
                                    ? language.t("session.share.popover.description.shared")
                                    : language.t("session.share.popover.description.unshared")}
                                </div>
                              </div>
                              <div class="mt-3 flex flex-col gap-2">
                                <Show
                                  when={shareUrl()}
                                  fallback={
                                    <Button
                                      size="large"
                                      variant="primary"
                                      class="w-full"
                                      onClick={shareSession}
                                      disabled={req.share}
                                    >
                                      {req.share
                                        ? language.t("session.share.action.publishing")
                                        : language.t("session.share.action.publish")}
                                    </Button>
                                  }
                                >
                                  <div class="flex flex-col gap-2">
                                    <TextField
                                      value={shareUrl() ?? ""}
                                      readOnly
                                      copyable
                                      copyKind="link"
                                      tabIndex={-1}
                                      class="w-full"
                                    />
                                    <div class="grid grid-cols-2 gap-2">
                                      <Button
                                        size="large"
                                        variant="secondary"
                                        class="w-full shadow-none border border-border-weak-base"
                                        onClick={unshareSession}
                                        disabled={req.unshare}
                                      >
                                        {req.unshare
                                          ? language.t("session.share.action.unpublishing")
                                          : language.t("session.share.action.unpublish")}
                                      </Button>
                                      <Button
                                        size="large"
                                        variant="primary"
                                        class="w-full"
                                        onClick={viewShare}
                                        disabled={req.unshare}
                                      >
                                        {language.t("session.share.action.view")}
                                      </Button>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          </KobaltePopover.Content>
                        </KobaltePopover.Portal>
                      </KobaltePopover>
                    </div>
                  )}
                </Show>
              </div>
              <div class="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                <div class="shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-11-medium text-text-base">
                  <span class="text-text-weaker">Model</span>
                  <span class="ml-1">{model()}</span>
                </div>
                <div class="shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-11-medium text-text-base">
                  <span class="text-text-weaker">Status</span>
                  <span class="ml-1">{state()}</span>
                </div>
                <div class="shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-11-medium text-text-base tabular-nums">
                  {token()}
                </div>
                <div class="shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-11-medium text-text-base tabular-nums">
                  {usd().format(usage().cost)}
                </div>
              </div>
              <div class="flex w-full items-center gap-1 overflow-x-auto no-scrollbar pt-1">
                <For each={filterOptions}>
                  {(item) => (
                    <button
                      type="button"
                      class="shrink-0 rounded-md px-2.5 py-1 text-12-medium transition-colors"
                      classList={{
                        "bg-surface-base-active text-text-strong": props.filter === item.id,
                        "text-text-weak hover:bg-surface-base-hover hover:text-text-base": props.filter !== item.id,
                      }}
                      onClick={() => props.onFilterChange(item.id)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div
              role="log"
              class="flex flex-col gap-12 items-start justify-start pb-16 transition-[margin]"
              classList={{
                "w-full": true,
                "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={rendered()}>
                {(message) => {
                  const messageID = message.id
                  const active = createMemo(() => activeMessageID() === messageID)
                  const comments = createMemo(() => messageComments(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
                  })
                  const commentCount = createMemo(() => comments().length)
                  const delegated = createMemo(() => pendingDelegation(info()?.dsl_context, messageID, sessionMessages()))
                  const delegation = createMemo(() => delegationProgress(info()?.dsl_context, messageID, sessionMessages()))
                  const completed = createMemo(() => turnDone(sessionMessages(), messageID, sessionStatus()))
                  const turn = createMemo(() =>
                    sessionMessages().find(
                      (item): item is UserMessage => item.id === messageID && item.role === "user",
                    ),
                  )
                  const stats = createMemo(() => turnStats(turn()))
                  const derived = createMemo(() => deriveTurnStats(sessionMessages(), messageID, sync.data.part))
                  const statText = createMemo(() => {
                    const tools = stats().tools ?? derived().tools
                    const children = stats().children ?? delegation().total
                    const actions = stats().actions ?? derived().actions
                    return [
                      tools ? `工具 ${num().format(tools)}` : "",
                      children ? `子会话 ${num().format(children)}` : "",
                      actions ? `Action ${num().format(actions)}` : "",
                      stats().confirmations ? `确认 ${num().format(stats().confirmations!)}` : "",
                    ].filter(Boolean)
                  })
                  const kids = createMemo(() => {
                    const map = new Map<string, DelegationItem>()
                    for (const item of [...delegation().active, ...delegation().completed]) {
                      if (map.has(item.id)) continue
                      map.set(item.id, item)
                    }
                    return Array.from(map.values())
                  })
                  const run = createMemo(() => kids().find((item) => item.run)?.run)
                  const question = createMemo(() => {
                    const req = props.request?.question
                    if (!match(req, messageID, sessionID(), kids(), sync.data.session, sessionMessages())) return
                    return req
                  })
                  const all = createMemo(() => confirmations(info()?.dsl_context, messageID, sessionMessages()))
                  const questionKey = createMemo(() => questionConfirmationKey(question()))
                  const confirms = createMemo(() => visibleConfirmations(all(), questionKey()))
                  const questionConfirm = createMemo(() => {
                    const key = questionKey()
                    if (!key) return false
                    return confirms().some((item) => item.status === "pending" && confirmationKey(item) === key)
                  })
                  const confirmRequest = (item: ConfirmRecord) => {
                    if (item.status !== "pending") return
                    if (confirmationKey(item) === questionKey()) return question()
                    return protocolConfirmationRequest({ item, sessionID: sessionID() })
                  }
                  const permission = createMemo(() => {
                    const req = props.request?.permission
                    if (!match(req, messageID, sessionID(), kids(), sync.data.session, sessionMessages())) return
                    return req
                  })
                  const [questionOpen, setQuestionOpen] = createSignal(true)
                  const [permissionOpen, setPermissionOpen] = createSignal(true)
                  const [kidsOpen, setKidsOpen] = createSignal(true)
                  return (
                    <div
                      id={props.anchor(messageID)}
                      data-message-id={messageID}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "md:max-w-200 2xl:max-w-[1000px]": props.centered,
                      }}
                    >
                      <Show when={props.filter === "all" && commentCount() > 0}>
                        <div class="w-full px-4 md:px-5 pb-2">
                          <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                            <div class="flex w-max min-w-full justify-end gap-2">
                              <Index each={comments()}>
                                {(commentAccessor: () => MessageComment) => {
                                  const comment = createMemo(() => commentAccessor())
                                  return (
                                    <Show when={comment()}>
                                      {(c) => (
                                        <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                                          <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                            <FileIcon
                                              node={{ path: c().path, type: "file" }}
                                              class="size-3.5 shrink-0"
                                            />
                                            <span class="truncate">{getFilename(c().path)}</span>
                                            <Show when={c().selection}>
                                              {(selection) => (
                                                <span class="shrink-0 text-text-weak">
                                                  {selection().startLine === selection().endLine
                                                    ? `:${selection().startLine}`
                                                    : `:${selection().startLine}-${selection().endLine}`}
                                                </span>
                                              )}
                                            </Show>
                                          </div>
                                          <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                            {c().comment}
                                          </div>
                                        </div>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                            </div>
                          </div>
                        </div>
                      </Show>
                      <SessionTurn
                        sessionID={sessionID() ?? ""}
                        messageID={messageID}
                        actions={props.actions}
                        filter={props.filter}
                        active={active()}
                        status={active() ? sessionStatus() : undefined}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        classes={{
                          root: "min-w-0 w-full relative",
                          content: "flex flex-col justify-between !overflow-visible",
                          container: "w-full px-6 md:px-8",
                        }}
                      />
                      <Show when={active() && safe(sessionStatus()) && sessionID()}>
                        {(id) => (
                          <SessionOutputSafetyCard
                            sessionID={id()}
                            messageID={messageID}
                            status={sessionStatus()}
                            onContinue={props.actions?.continue}
                          />
                        )}
                      </Show>
                      <Show when={props.filter === "all"}>
                        <For each={confirms()}>
                          {(item) => (
                            <SessionConfirmationCard
                              item={item}
                              request={confirmRequest(item)}
                              submit={props.request?.submit ?? (() => undefined)}
                            />
                          )}
                        </For>
                      </Show>
                      <Show when={props.filter === "all" && active() && !questionConfirm() ? question() : undefined} keyed>
                        {(request) => {
                          const submit = props.request!.submit
                          return (
                            <div class="px-6 md:px-8 pt-4">
                              <div
                                data-component="session-request-card"
                                class="rounded-md border border-border-weak-base bg-background-base overflow-hidden"
                              >
                                <button
                                  type="button"
                                  class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-12-medium text-text-strong"
                                  aria-expanded={questionOpen()}
                                  onClick={() => setQuestionOpen((value) => !value)}
                                >
                                  <span>需要确认</span>
                                  <span
                                    class="inline-flex text-icon-weak transition-transform"
                                    classList={{ "-rotate-90": !questionOpen() }}
                                  >
                                    <Icon name="chevron-down" size="small" />
                                  </span>
                                </button>
                                <Show when={questionOpen()}>
                                  <div class="border-t border-border-weaker-base p-2">
                                    <SessionQuestionDock request={request} onSubmit={submit} />
                                  </div>
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </Show>
                      <Show when={props.filter === "all" && active() && permission()}>
                        {(request) => {
                          const req = request()
                          const decide = props.request!.decide
                          return (
                            <div class="px-6 md:px-8 pt-4">
                              <div
                                data-component="session-request-card"
                                class="rounded-md border border-border-weak-base bg-background-base overflow-hidden"
                              >
                                <button
                                  type="button"
                                  class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-12-medium text-text-strong"
                                  aria-expanded={permissionOpen()}
                                  onClick={() => setPermissionOpen((value) => !value)}
                                >
                                  <span>权限确认</span>
                                  <span
                                    class="inline-flex text-icon-weak transition-transform"
                                    classList={{ "-rotate-90": !permissionOpen() }}
                                  >
                                    <Icon name="chevron-down" size="small" />
                                  </span>
                                </button>
                                <Show when={permissionOpen()}>
                                  <div class="border-t border-border-weaker-base p-2">
                                    <SessionPermissionDock
                                      request={req}
                                      responding={props.request?.responding ?? false}
                                      onDecide={decide}
                                    />
                                  </div>
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </Show>
                      <Show when={props.filter === "all" && (completed() || delegation().total > 0)}>
                        <div class="px-6 md:px-8 pt-8">
                          <div class="flex items-center gap-3 text-12-regular text-text-weak">
                            <div class="h-px flex-1 bg-border-weaker-base" />
                            <span class="shrink-0 inline-flex items-center gap-1.5">
                              <Show
                                when={delegated()}
                                fallback={<Icon name="circle-check" size="small" class="text-icon-success-base" />}
                              >
                                <Spinner class="size-3 text-text-interactive-base" />
                              </Show>
                              <span>
                                第 {ordinal(messageID)} 轮 · {delegated() ? delegationLabel : completeLabel}
                              </span>
                              <Show when={delegation().total > 0}>
                                <span class="shrink-0">
                                  （{delegation().done}/{delegation().total}）
                                </span>
                              </Show>
                              <Show when={statText().length > 0}>
                                <span class="shrink-0 text-11-regular text-text-weaker">
                                  {statText().join(" · ")}
                                </span>
                              </Show>
                            </span>
                            <div class="h-px flex-1 bg-border-weaker-base" />
                          </div>
                          <Show when={kids().length > 0}>
                            <div class="mt-3 rounded-md border border-border-weak-base bg-background-base">
                              <button
                                type="button"
                                class="flex w-full items-center justify-between gap-2 border-b border-border-weaker-base px-3 py-2 text-left"
                                aria-expanded={kidsOpen()}
                                onClick={() => setKidsOpen((value) => !value)}
                              >
                                <div class="min-w-0 text-12-medium text-text-strong">子会话</div>
                                <div class="shrink-0 flex items-center gap-2">
                                  <span class="text-11-regular text-text-weak">
                                    {delegation().done}/{delegation().total}
                                  </span>
                                  <span
                                    class="inline-flex text-icon-weak transition-transform"
                                    classList={{ "-rotate-90": !kidsOpen() }}
                                  >
                                    <Icon name="chevron-down" size="small" />
                                  </span>
                                </div>
                              </button>
                              <Show when={kidsOpen()}>
                                <div class="max-h-[360px] overflow-y-auto" data-scrollable>
                                  <For each={kids()}>
                                    {(item) => {
                                      const status = createMemo(() => sync.data.session_status[item.id]?.type ?? "idle")
                                      const info = createMemo(() => sync.session.get(item.id))
                                      const busy = createMemo(() => !!op.child[item.id])
                                      return (
                                        <div class="grid grid-cols-[1fr_auto] gap-2 border-b border-border-weaker-base/70 px-3 py-2 last:border-b-0">
                                          <button
                                            type="button"
                                            class="min-w-0 text-left"
                                            onClick={() => navigate(`/${params.dir}/session/${item.id}`)}
                                          >
                                            <div class="flex min-w-0 items-center gap-2">
                                              <span class={`size-2 rounded-full shrink-0 ${dot(status())}`} />
                                              <span class="truncate text-12-medium text-text-strong">
                                                {info()?.title || item.label}
                                              </span>
                                              <span class="shrink-0 text-11-regular text-text-weak">{label(status())}</span>
                                            </div>
                                            <div class="mt-0.5 truncate text-11-regular text-text-weak">{item.id}</div>
                                          </button>
                                          <div class="flex items-center gap-1">
                                            <Button
                                              variant="ghost"
                                              size="small"
                                              class="h-7 px-2"
                                              onClick={() => navigate(`/${params.dir}/session/${item.id}`)}
                                            >
                                              {language.t("common.open")}
                                            </Button>
                                            <Show when={live.has(status())}>
                                              <Button
                                                variant="ghost"
                                                size="small"
                                                class="h-7 px-2"
                                                disabled={busy()}
                                                onClick={() => void pause(item.id)}
                                              >
                                                暂停
                                              </Button>
                                            </Show>
                                            <Show when={restorable.has(status())}>
                                              <Button
                                                variant="secondary"
                                                size="small"
                                                class="h-7 px-2"
                                                disabled={busy()}
                                                onClick={() => void resume(item.id)}
                                              >
                                                恢复
                                              </Button>
                                            </Show>
                                            <Show when={fallbackable.has(status())}>
                                              <Button
                                                variant="secondary"
                                                size="small"
                                                class="h-7 px-2"
                                                disabled={busy()}
                                                onClick={() => void openFallback(item.id)}
                                              >
                                                确认结果
                                              </Button>
                                            </Show>
                                            <Show when={!done.has(status())}>
                                              <Button
                                                variant="ghost"
                                                size="small"
                                                class="h-7 px-2"
                                                disabled={busy()}
                                                onClick={() => void mark(item.id, "User marked delegated child session complete.")}
                                              >
                                                标完成
                                              </Button>
                                            </Show>
                                          </div>
                                        </div>
                                      )
                                    }}
                                  </For>
                                </div>
                                <div class="flex items-center justify-end gap-2 border-t border-border-weaker-base px-3 py-2">
                                  <Button
                                    variant="ghost"
                                    size="small"
                                    class="h-7 px-2"
                                    disabled={!run() || !!op.child[`cancel:${run()}`]}
                                    onClick={() => {
                                      const id = run()
                                      if (!id) return
                                      void cancelRun(id)
                                    }}
                                  >
                                    取消子会话并继续
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="small"
                                    class="h-7 px-2"
                                    disabled={!run() || !!op.child[`submit:${run()}`]}
                                    onClick={() => {
                                      const id = run()
                                      if (!id) return
                                      void submit(id)
                                    }}
                                  >
                                    不再等待
                                  </Button>
                                </div>
                              </Show>
                            </div>
                          </Show>
                          <SessionTurnDiffs diffs={turn()?.summary?.diffs ?? []} />
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </ScrollView>
      </div>
    </Show>
  )
}
