import { For, createEffect, createMemo, on, onCleanup, Show, Index, type JSX } from "solid-js"
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
import { SessionTurn, SessionTurnDiffs, type SessionTurnFilter } from "@open-agent-harness/ui/session-turn"
import { ScrollView } from "@open-agent-harness/ui/scroll-view"
import { TextField } from "@open-agent-harness/ui/text-field"
import type { AssistantMessage, Message as MessageType, Part, TextPart, UserMessage } from "@open-agent-harness/sdk/v2"
import { showToast } from "@open-agent-harness/ui/toast"
import { Binary } from "@open-agent-harness/util/binary"
import { getFilename } from "@open-agent-harness/util/path"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { isSessionBusy } from "@/pages/session/helpers"

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

const text = (input: unknown) => (typeof input === "string" ? input : undefined)

type DelegationState = {
  total: number
  done: number
  active: { id: string; label: string }[]
  completed: { id: string; label: string }[]
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const delegationItem = (input: unknown): input is { parent_message_id: string; child_session_id: string; action_title?: unknown } =>
  record(input) &&
  typeof input.parent_message_id === "string" &&
  typeof input.child_session_id === "string"

const delegationRows = (input: unknown, messageID: string) => {
  if (!Array.isArray(input)) return []
  const rows = input
    .filter((item): item is { parent_message_id: string; child_session_id: string; action_title?: unknown } =>
      delegationItem(item) && item.parent_message_id === messageID,
    )
    .reduce(
      (acc: Map<string, { id: string; label: string }>, item) => {
        if (acc.has(item.child_session_id)) return acc
        const label = text(item.action_title) || `子会话 ${String(item.child_session_id)}`
        acc.set(item.child_session_id, { id: item.child_session_id, label })
        return acc
      },
      new Map<string, { id: string; label: string }>(),
    )
  return Array.from(rows.values())
}

const pendingDelegation = (input: unknown, messageID: string) => {
  if (!record(input)) return false
  const protocol = input.protocol
  if (!record(protocol)) return false
  const pending = protocol.pending_delegations
  if (!record(pending)) return false
  return Object.values(pending).some((item) => record(item) && item.parent_message_id === messageID)
}

const delegationProgress = (input: unknown, messageID: string): DelegationState => {
  if (!record(input)) return { total: 0, done: 0, active: [], completed: [] }
  const protocol = input.protocol
  if (!record(protocol)) return { total: 0, done: 0, active: [], completed: [] }

  const active = Object.values(record(protocol.pending_delegations) ? protocol.pending_delegations : {})
    .filter((item): item is { parent_message_id: string; child_session_id: string; action_title?: unknown } =>
      delegationItem(item) && item.parent_message_id === messageID,
    )
    .map((item) => ({
      id: String(item.child_session_id),
      label: text(item.action_title) || `子会话 ${String(item.child_session_id)}`,
    }))

  const completed = delegationRows(protocol.completed_delegations, messageID)

  const completedIds = completed.map((item) => item.id)
  const totalItems = new Set(active.map((item) => item.id).concat(completedIds))
  for (const item of completed) totalItems.add(item.id)

  return {
    total: totalItems.size,
    done: completed.length,
    active,
    completed,
  }
}

const done = (messages: MessageType[], id: string) => {
  const idx = messages.findIndex((item) => item.id === id)
  if (idx === -1) return false
  const assistants: AssistantMessage[] = []
  for (let i = idx + 1; i < messages.length; i++) {
    const item = messages[i]
    if (!item) continue
    if (item.role === "user") break
    if (item.role === "assistant" && item.parentID === id) assistants.push(item as AssistantMessage)
  }
  if (assistants.length === 0) return false
  return assistants.every((item) => typeof item.time.completed === "number")
}

type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  retry?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  context?: (input: { sessionID: string; messageID: string; text: string }) => Promise<void> | void
  continue?: (input: { sessionID: string; messageID: string; text: string }) => Promise<void> | void
  prompt?: (input: { sessionID: string; messageID: string; text: string }) => Promise<void> | void
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

type StageConfig = {
  init: number
  batch: number
}

type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        cancel()
        const shouldStage =
          isWindowed &&
          total > input.config.init &&
          state.completedSession !== sessionKey &&
          state.activeSession !== sessionKey
        if (!shouldStage) {
          setState({ activeSession: "", count: total })
          return
        }

        let count = Math.min(total, input.config.init)
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          setState("count", count)
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })

  onCleanup(cancel)
  return { messages: stagedUserMessages, isStaging }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
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
  const { params, sessionKey } = useSessionKey()
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
  const working = createMemo(() => !!pending() || isSessionBusy(sessionStatus()))
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))
  const turnMatches = (id: string) => {
    if (props.filter === "all" || props.filter === "input") return true
    const messages = sessionMessages()
    const index = messages.findIndex((item) => item.id === id)
    if (index === -1) return false

    for (let i = index + 1; i < messages.length; i++) {
      const item = messages[i]
      if (!item) continue
      if (item.role === "user") break
      if (item.role !== "assistant" || item.parentID !== id) continue
      const parts = sync.data.part[item.id] ?? []
      if (props.filter === "thinking" && parts.some((part) => part.type === "reasoning")) return true
      if (props.filter === "output" && parts.some((part) => part.type === "text")) return true
      if (props.filter === "tool" && parts.some((part) => part.type === "tool")) return true
    }

    return false
  }
  const rendered = createMemo(() => props.renderedUserMessages.filter((message) => turnMatches(message.id)).map((message) => message.id))

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
    if (status.type !== "idle") {
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
  const showHeader = createMemo(() => true)
  const filterOptions: { id: SessionTurnFilter; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "thinking", label: "思考" },
    { id: "input", label: "输入" },
    { id: "output", label: "输出" },
    { id: "tool", label: "工具调用" },
  ]
  const stageCfg = { init: 1, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })

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

  const [req, setReq] = createStore({ share: false, unshare: false })

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
            "opacity-100 translate-y-0 scale-100":
              props.scroll.overflow && !props.scroll.bottom && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || props.scroll.bottom || staging.isStaging(),
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
            "--session-title-height": showHeader() ? "80px" : "0px",
            "--sticky-accordion-top": showHeader() ? "88px" : "0px",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <Show when={showHeader()}>
              <div
                data-session-title
                classList={{
                  "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
                  "w-full": true,
                  "pb-4": true,
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
                <div class="flex w-full items-center gap-1 overflow-x-auto no-scrollbar pb-1">
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
            </Show>

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
                {(messageID) => {
                  const active = createMemo(() => activeMessageID() === messageID)
                  const comments = createMemo(() => messageComments(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
                  })
                  const commentCount = createMemo(() => comments().length)
                  const delegated = createMemo(() => pendingDelegation(info()?.dsl_context, messageID))
                  const delegation = createMemo(() => delegationProgress(info()?.dsl_context, messageID))
                  const completed = createMemo(() => sessionStatus().type === "idle" && done(sessionMessages(), messageID))
                  const turn = createMemo(() =>
                    sessionMessages().find((item): item is UserMessage => item.id === messageID && item.role === "user"),
                  )
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
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                      <Show when={props.filter === "all" && (completed() || delegation().total > 0)}>
                        <div class="px-4 md:px-5 pt-8">
                          <div class="flex items-center gap-3 text-12-regular text-text-weak">
                            <div class="h-px flex-1 bg-border-weaker-base" />
                            <span class="shrink-0 inline-flex items-center gap-1.5">
                              <Show
                                when={delegated()}
                                fallback={<Icon name="circle-check" size="small" class="text-icon-success-base" />}
                              >
                                <Spinner class="size-3 text-text-interactive-base" />
                              </Show>
                              <span>{delegated() ? delegationLabel : completeLabel}</span>
                              <Show when={delegation().total > 0}>
                                <span class="shrink-0">（{delegation().done}/{delegation().total}）</span>
                              </Show>
                            </span>
                            <div class="h-px flex-1 bg-border-weaker-base" />
                          </div>
                          <Show when={delegation().active.length > 0}>
                            <div class="pt-2 text-11-regular text-text-weak">
                              <span class="font-semibold">正在处理:</span>
                              <span class="inline-flex flex-wrap gap-1 pl-1">
                                <For each={delegation().active}>
                                  {(item) => <span class="rounded-md border border-border-weaker-base px-2 py-0.5">{item.label}</span>}
                                </For>
                              </span>
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
