import type { Message, Session, TextPart, UserMessage } from "@open-agent-harness/sdk/v2/client"
import { Avatar } from "@open-agent-harness/ui/avatar"
import { HoverCard } from "@open-agent-harness/ui/hover-card"
import { Icon } from "@open-agent-harness/ui/icon"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { MessageNav } from "@open-agent-harness/ui/message-nav"
import { Spinner } from "@open-agent-harness/ui/spinner"
import { showToast } from "@open-agent-harness/ui/toast"
import { Tooltip } from "@open-agent-harness/ui/tooltip"
import { base64Encode } from "@open-agent-harness/util/encode"
import { getFilename } from "@open-agent-harness/util/path"
import { A, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import {
  displaySessionTitle,
  hasProjectPermissions,
  sessionCompleted,
  sessionWorking,
} from "./helpers"

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

export type Filter = "running" | "ended" | "failed" | "success"

const indent = 24

const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const duration = (session: Session, messages: Message[] | undefined, working: boolean, now: number) => {
  const user = messages?.find((item) => item.role === "user")
  const assistant = messages?.findLast((item) => item.role === "assistant")
  const start = user?.time.created ?? session.time.created
  const end = working ? now : assistant?.time.completed ?? session.time.updated ?? session.time.created
  return formatDuration(end - start)
}

const StatusBadge = (props: {
  label: Accessor<string>
  status: Accessor<string | undefined>
  isWaitingChild: Accessor<boolean>
  isWorking: Accessor<boolean>
  isPaused: Accessor<boolean>
  isDone: Accessor<boolean>
  hasError: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  unseenCount: Accessor<number>
}): JSX.Element => {
  const queued = createMemo(() => props.status() === "rate_limited")
  const retry = createMemo(() => props.status() === "retry")
  const blocked = createMemo(() => props.hasPermissions() || props.status() === "blocked" || props.status() === "waiting_permission")
  const waiting = createMemo(() => props.status() === "waiting_user")
  const tip = createMemo(() => (props.isWaitingChild() ? "等待子会话完成" : props.label()))
  return (
    <Tooltip value={tip()} placement="top">
      <div
        class="relative shrink-0 size-5 rounded-full flex items-center justify-center border bg-background-base"
        classList={{
          "border-icon-info-active text-text-interactive-base": props.isWorking(),
          "border-icon-warning-base text-icon-warning-base": props.isPaused() || queued() || retry() || props.isWaitingChild(),
          "border-icon-critical-base text-icon-critical-base": props.hasError() || blocked(),
          "border-text-diff-add-base text-text-diff-add-base": props.isDone(),
          "border-border-weak-base text-text-weak": !props.isWorking() && !props.isPaused() && !queued() && !retry() && !props.isWaitingChild() && !props.hasPermissions() && !props.hasError() && !props.isDone(),
        }}
      >
        <Show when={props.isWorking()}>
          <span class="absolute inset-0 rounded-full border border-icon-info-active opacity-25 animate-ping motion-reduce:animate-none" />
          <Spinner class="absolute size-4 opacity-40" />
        </Show>
        <Show when={props.isWorking() || props.isWaitingChild()}>
          <span class="relative z-10 max-w-[18px] overflow-hidden text-center text-[7px] leading-none font-medium tabular-nums">
            {props.label()}
          </span>
        </Show>
        <Show when={!props.isWorking() && !props.isWaitingChild()}>
          <Show when={props.hasError()} fallback={
            <Show when={blocked()} fallback={
              <Show when={queued()} fallback={
                <Show when={retry()} fallback={
                  <Show when={waiting()} fallback={
                    <Show when={props.isWaitingChild()} fallback={
                      <Show when={props.isDone()} fallback={<Icon name="dash" size="small" />}>
                        <Icon name="check-small" size="small" />
                      </Show>
                    }>
                      <Icon name="hourglass" size="small" class="animate-pulse motion-reduce:animate-none" />
                    </Show>
                  }>
                    <Icon name="prompt" size="small" />
                  </Show>
                }>
                  <Icon name="reset" size="small" class="animate-spin motion-reduce:animate-none" />
                </Show>
              }>
                <Icon name="status" size="small" />
              </Show>
            }>
              <Icon name="circle-ban-sign" size="small" />
            </Show>
          }>
            <Icon name="circle-x" size="small" />
          </Show>
        </Show>
        <Show when={props.unseenCount() > 0 && !props.isWorking() && !props.isPaused() && !props.hasError() && !props.isDone()}>
          <span class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-text-interactive-base" />
        </Show>
      </div>
    </Tooltip>
  )
}
const filterLabel = (filter: Filter) => {
  if (filter === "running") return "运行中"
  if (filter === "ended") return "已结束"
  if (filter === "failed") return "已失败"
  return "已成功"
}

export const SessionFilterBar = (props: {
  filter: Accessor<Filter | undefined>
  setFilter: (filter: Filter | undefined) => void
}): JSX.Element => (
  <div class="px-2 pb-1 flex flex-wrap gap-1">
    <button
      type="button"
      class="rounded px-2 py-0.5 text-11-regular transition-colors"
      classList={{
        "bg-surface-base-active text-text-strong": props.filter() === undefined,
        "bg-transparent text-text-weak hover:bg-surface-base-hover": props.filter() !== undefined,
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.setFilter(undefined)
      }}
    >
      全部
    </button>
    <For each={["running", "ended", "failed", "success"] as Filter[]}>
      {(item) => (
        <button
          type="button"
          class="rounded px-2 py-0.5 text-11-regular transition-colors"
          classList={{
            "bg-surface-base-active text-text-strong": props.filter() === item,
            "bg-transparent text-text-weak hover:bg-surface-base-hover": props.filter() !== item,
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.setFilter(props.filter() === item ? undefined : item)
          }}
        >
          {filterLabel(item)}
        </button>
      )}
    </For>
  </div>
)

const treeX = (depth: number | undefined) => (depth ?? 0) * indent + 38
const row = (dense?: boolean) => (dense ? "24px" : "28px")
const mid = (dense?: boolean) => (dense ? "12px" : "14px")
const end = (dense?: boolean) => (dense ? "22px" : "24px")
const drop = (dense?: boolean) => (dense ? "24px" : "28px")
const line = { "background-color": "var(--border-base)" }
const trunk = (dense?: boolean, first?: boolean, last?: boolean) => {
  const top = mid(dense)
  if (first && last) return { top, height: "0px" }
  if (last) return { top: "0", height: top }
  return { top: first ? top : "0", bottom: "0" }
}

const sessionFilter = (input: {
  session: Session
  filter: Filter | undefined
  messages: Message[] | undefined
  status: { type?: string } | undefined
  hasError: boolean
  hasPermissions: boolean
}) => {
  if (!input.filter) return true
  const working = !input.hasPermissions && sessionWorking(input.messages, input.status)
  const done = !input.hasPermissions && !working && !input.hasError && sessionCompleted(input.session, input.messages, input.status)
  if (input.filter === "running") return working
  if (input.filter === "failed") return input.hasError
  if (input.filter === "success") return done
  return !working
}

export const ProjectIcon = (props: { project: LocalProject; class?: string; notify?: boolean }): JSX.Element => {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))
  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={
            props.project.id === OPENCODE_PROJECT_ID ? "https://opencode.ai/favicon.svg" : props.project.icon?.override
          }
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  popover?: boolean
  depth?: number
  first?: boolean
  last?: boolean
  expanded?: Accessor<Record<string, boolean>>
  lineage?: Accessor<Set<string>>
  filter?: Accessor<Filter | undefined>
  setExpanded?: (id: string, value: boolean) => void
  children: Map<string, string[]>
  childSummary?: Map<string, { completed: number; total: number; working: number }>
  collapseByDefault?: Accessor<boolean>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  title: Accessor<string>
  childSummary: Accessor<{ completed: number; total: number; working: number } | undefined>
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  status: Accessor<string | undefined>
  isWaitingChild: Accessor<boolean>
  isWorking: Accessor<boolean>
  isPaused: Accessor<boolean>
  isDone: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  durationLabel: Accessor<string>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmHover: () => void
  warmPress: () => void
  warmFocus: () => void
  cancelHoverPrefetch: () => void
  depth?: number
  canExpand?: Accessor<boolean>
  expanded?: Accessor<boolean>
  toggle?: () => void
}): JSX.Element => (
  <div class="flex items-center min-w-0" style={{ "padding-left": `${(props.depth ?? 0) * indent}px` }}>
    <Show when={props.canExpand?.()} fallback={<span class="shrink-0 size-5" aria-hidden="true" />}>
      <button
        type="button"
        class="shrink-0 size-5 rounded flex items-center justify-center text-icon-weak focus:outline-none focus-visible:bg-surface-base-active"
        classList={{
          "hover:bg-surface-base-hover": !props.expanded?.(),
          "opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100": props.expanded?.(),
        }}
        aria-expanded={props.expanded?.() ?? false}
        aria-label="Toggle session children"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.toggle?.()
        }}
      >
        <Show when={!props.expanded?.()} fallback={<Icon name="chevron-down" size="small" />}>
          <Icon name="chevron-right" size="small" />
        </Show>
      </button>
    </Show>
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none transition-[padding] ${props.mobile ? "pr-[52px]" : "pr-7"} group-hover/session:pr-[52px] group-focus-within/session:pr-[52px] group-active/session:pr-[52px] ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={props.warmPress}
      onPointerEnter={props.warmHover}
      onPointerLeave={props.cancelHoverPrefetch}
      onFocus={props.warmFocus}
      onClick={() => {
        props.setHoverSession(undefined)
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="flex items-center gap-1 w-full">
        <StatusBadge
          label={props.durationLabel}
          status={props.status}
          isWaitingChild={props.isWaitingChild}
          isWorking={props.isWorking}
          isPaused={props.isPaused}
          isDone={props.isDone}
          hasPermissions={props.hasPermissions}
          hasError={props.hasError}
          unseenCount={props.unseenCount}
        />
        <span class="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate">
          {props.title()}
        </span>
        <Show when={props.childSummary()}>
          {(summary) => (
            <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-11-regular tabular-nums text-text-weak">
              {summary().completed}/{summary().total}
            </span>
          )}
        </Show>
      </div>
    </A>
  </div>
)

const SessionHoverPreview = (props: {
  mobile?: boolean
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  session: Session
  sidebarHovering: Accessor<boolean>
  hoverReady: Accessor<boolean>
  hoverMessages: Accessor<UserMessage[] | undefined>
  language: ReturnType<typeof useLanguage>
  isActive: Accessor<boolean>
  slug: string
  setHoverSession: (id: string | undefined) => void
  messageLabel: (message: Message) => string | undefined
  onMessageSelect: (message: Message) => void
  trigger: JSX.Element
}): JSX.Element => (
  <HoverCard
    openDelay={1000}
    closeDelay={props.sidebarHovering() ? 600 : 0}
    placement="right-start"
    gutter={16}
    shift={-2}
    trigger={props.trigger}
    open={props.hoverSession() === props.session.id}
    onOpenChange={(open) => props.setHoverSession(open ? props.session.id : undefined)}
  >
    <Show
      when={props.hoverReady()}
      fallback={<div class="text-12-regular text-text-weak">{props.language.t("session.messages.loading")}</div>}
    >
      <div class="overflow-y-auto overflow-x-hidden max-h-72 h-full">
        <MessageNav
          messages={props.hoverMessages() ?? []}
          current={undefined}
          getLabel={props.messageLabel}
          onMessageSelect={props.onMessageSelect}
          size="normal"
          class="w-60"
        />
      </div>
    </Show>
  </HoverCard>
)

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const globalSync = useGlobalSync()
  const [sessionStore] = globalSync.child(props.session.directory)
  const status = createMemo(() => sessionStore.session_status[props.session.id])
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id) || status()?.type === "error" || status()?.type === "timeout")
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const [now, setNow] = createSignal(Date.now())
  const isPaused = createMemo(() => {
    const next = status()?.type
    return hasPermissions() || next === "waiting_user" || next === "waiting_permission"
  })
  const isWorking = createMemo(() => {
    if (isPaused()) return false
    return sessionWorking(sessionStore.message[props.session.id], status())
  })
  const childSummary = createMemo(() => {
    const summary = props.childSummary?.get(props.session.id)
    if (!summary || summary.total === 0) return
    return summary
  })
  const isDone = createMemo(() => {
    if (hasPermissions() || isWorking() || hasError() || childSummary()?.working) return false
    return sessionCompleted(props.session, sessionStore.message[props.session.id], status())
  })
  createEffect(() => {
    if (!isWorking()) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(id))
  })

  const tint = createMemo(() => {
    return messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent)
  })
  const durationLabel = createMemo(() =>
    duration(props.session, sessionStore.message[props.session.id], isWorking(), now()),
  )

  const hoverMessages = createMemo(() =>
    sessionStore.message[props.session.id]?.filter((message): message is UserMessage => message.role === "user"),
  )
  const hoverReady = createMemo(() => hoverMessages() !== undefined)
  const hoverAllowed = createMemo(() => !props.mobile && props.sidebarExpanded())
  const hoverEnabled = createMemo(() => (props.popover ?? true) && hoverAllowed())
  const isActive = createMemo(() => props.session.id === params.id)
  const childSessions = createMemo(() => {
    const by = new Map(props.list.map((session) => [session.id, session]))
    return (props.children.get(props.session.id) ?? [])
      .map((id) => by.get(id))
      .filter((session): session is Session => !!session && !session.time?.archived)
  })
  const matches = (session: Session) => {
    const next = sessionStore.session_status[session.id]
    const blocked = !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, session.id, (item) => {
      return !permission.autoResponds(item, session.directory)
    })
    return sessionFilter({
      session,
      filter: props.filter?.(),
      messages: sessionStore.message[session.id],
      status: next,
      hasError: notification.session.unseenHasError(session.id) || next?.type === "error" || next?.type === "timeout",
      hasPermissions: blocked,
    })
  }
  const visible = (session: Session): boolean => {
    if (matches(session)) return true
    const by = new Map(props.list.map((item) => [item.id, item]))
    return (props.children.get(session.id) ?? []).some((id) => {
      const child = by.get(id)
      return !!child && !child.time?.archived && visible(child)
    })
  }
  const childVisible = (session: Session) => visible(session)
  const filteredChildren = createMemo(() => childSessions().filter(childVisible))
  const title = createMemo(() => {
    if (!props.session.parentID) return displaySessionTitle(props.session)
    const ids = props.children.get(props.session.parentID) ?? []
    const idx = ids
      .filter((id) => props.list.some((session) => session.id === id && !session.time?.archived))
      .indexOf(props.session.id)
    return displaySessionTitle(props.session, idx === -1 ? undefined : idx)
  })
  const isWaitingChild = createMemo(() => !isWorking() && !hasError() && !hasPermissions() && !!childSummary()?.working)
  const canExpand = createMemo(() => childSessions().length > 0)
  const expanded = createMemo(() => {
    if (props.lineage?.().has(props.session.id)) return true
    const value = props.expanded?.()[props.session.id]
    if (props.collapseByDefault?.()) return value === true
    return value !== false
  })
  const toggle = () => props.setExpanded?.(props.session.id, !expanded())
  const copy = () => {
    void navigator.clipboard
      .writeText(title())
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: title(),
        })
      })
      .catch(() => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
        })
      })
  }

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const hoverPrefetch = {
    current: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const cancelHoverPrefetch = () => {
    if (hoverPrefetch.current === undefined) return
    clearTimeout(hoverPrefetch.current)
    hoverPrefetch.current = undefined
  }
  const scheduleHoverPrefetch = () => {
    if (props.collapseByDefault?.()) return
    warm(1, "high")
    if (hoverPrefetch.current !== undefined) return
    hoverPrefetch.current = setTimeout(() => {
      hoverPrefetch.current = undefined
      warm(2, "low")
    }, 80)
  }

  onCleanup(cancelHoverPrefetch)

  const messageLabel = (message: Message) => {
    const parts = sessionStore.part[message.id] ?? []
    const text = parts.find((part): part is TextPart => part?.type === "text" && !part.synthetic && !part.ignored)
    return text?.text
  }
  const item = (
    <SessionRow
      session={props.session}
      title={title}
      childSummary={childSummary}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      status={() => status()?.type}
      isWaitingChild={isWaitingChild}
      isWorking={isWorking}
      isPaused={isPaused}
      isDone={isDone}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      durationLabel={durationLabel}
      setHoverSession={props.setHoverSession}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      depth={props.depth}
      canExpand={canExpand}
      expanded={expanded}
      toggle={toggle}
      warmHover={scheduleHoverPrefetch}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      cancelHoverPrefetch={cancelHoverPrefetch}
    />
  )

  return (
    <Show when={visible(props.session)}>
      <div
        class="relative"
        classList={{
          "border-t border-border-weaker-base mt-1 pt-1": !props.session.parentID && props.first === false,
        }}
      >
        <Show when={expanded() && filteredChildren().length > 0}>
          <div
            class="pointer-events-none absolute z-10 w-px"
            style={{
              top: end(props.dense),
              left: `${treeX((props.depth ?? 0) + 1)}px`,
              height: drop(props.dense),
              ...line,
            }}
          />
        </Show>
        <Show when={props.session.parentID}>
          <div
            class="pointer-events-none absolute w-px"
            style={{ left: `${treeX(props.depth)}px`, ...trunk(props.dense, props.first, props.last), ...line }}
          />
          <div
            class="pointer-events-none absolute h-px"
            style={{ top: mid(props.dense), left: `${treeX(props.depth) - 18}px`, width: "18px", ...line }}
          />
        </Show>
        <div
          data-session-id={props.session.id}
          class="group/session relative w-full rounded-md cursor-default pl-2 pr-3 transition-colors
               hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
        >
          <Show
            when={hoverEnabled()}
            fallback={
              <Tooltip placement={props.mobile ? "bottom" : "right"} value={title()} gutter={10}>
                {item}
              </Tooltip>
            }
          >
            <SessionHoverPreview
              mobile={props.mobile}
              nav={props.nav}
              hoverSession={props.hoverSession}
              session={props.session}
              sidebarHovering={props.sidebarHovering}
              hoverReady={hoverReady}
              hoverMessages={hoverMessages}
              language={language}
              isActive={isActive}
              slug={props.slug}
              setHoverSession={props.setHoverSession}
              messageLabel={messageLabel}
              onMessageSelect={(message) => {
                if (!isActive())
                  layout.pendingMessage.set(`${base64Encode(props.session.directory)}/${props.session.id}`, message.id)

                navigate(`${props.slug}/session/${props.session.id}#message-${message.id}`)
              }}
              trigger={item}
            />
          </Show>

          <div
            class={`absolute ${props.dense ? "top-0.5 right-0.5" : "top-1 right-1"} flex items-center gap-0.5 pointer-events-auto`}
          >
            <Tooltip value={language.t("session.copyName")} placement="top">
              <IconButton
                icon="copy"
                variant="ghost"
                class="size-6 rounded-md"
                aria-label={language.t("session.copyName")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  copy()
                }}
              />
            </Tooltip>
            <div
              class="transition-opacity"
              classList={{
                "opacity-100 pointer-events-auto": !!props.mobile,
                "opacity-0 pointer-events-none": !props.mobile,
                "group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                "group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
              }}
            >
              <Tooltip value={language.t("common.archive")} placement="top">
                <IconButton
                  icon="archive"
                  variant="ghost"
                  class="size-6 rounded-md"
                  aria-label={language.t("common.archive")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void props.archiveSession(props.session)
                  }}
                />
              </Tooltip>
            </div>
          </div>
        </div>

        <Show when={expanded()}>
          <For each={filteredChildren()}>
            {(session, index) => (
              <SessionItem
                {...props}
                session={session}
                depth={(props.depth ?? 0) + 1}
                first={index() === 0}
                last={index() === filteredChildren().length - 1}
              />
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  setHoverSession: (id: string | undefined) => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        props.setHoverSession(undefined)
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="flex items-center gap-1 w-full">
        <div class="shrink-0 size-6 flex items-center justify-center">
          <Icon name="new-session" size="small" class="text-icon-weak" />
        </div>
        <span class="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate">
          {label}
        </span>
      </div>
    </A>
  )

  return (
    <div class="group/session relative w-full rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10}>
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
