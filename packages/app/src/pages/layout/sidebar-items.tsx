import type { Message, Session, TextPart, UserMessage } from "@open-agent-harness/sdk/v2/client"
import { Avatar } from "@open-agent-harness/ui/avatar"
import { HoverCard } from "@open-agent-harness/ui/hover-card"
import { Icon } from "@open-agent-harness/ui/icon"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { MessageNav } from "@open-agent-harness/ui/message-nav"
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
import { agentLabelByName } from "@/utils/agent"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import {
  displaySessionTitle,
  hasProjectPermissions,
  sessionAgentLabel,
  sessionWorking,
  type SessionFilter,
} from "./helpers"

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

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
  const end = working ? now : (assistant?.time.completed ?? session.time.updated ?? session.time.created)
  return formatDuration(end - start)
}

const StatusBadge = (props: {
  label: Accessor<string>
  status: Accessor<string | undefined>
  unseenCount: Accessor<number>
}): JSX.Element => {
  const type = createMemo(() => props.status() ?? "idle")
  const bad = createMemo(() => ["aborting", "aborted", "blocked", "error", "failed", "interrupted", "timeout"].includes(type()))
  const done = createMemo(() => ["archived", "completed", "terminal_reply"].includes(type()))
  const idle = createMemo(() => type() === "idle")
  const active = createMemo(() => ["queued", "rate_limited", "retry", "running", "starting", "waiting_child"].includes(type()))
  const icon = createMemo(() => {
    const value = type()
    if (value === "completed") return "check-small"
    if (value === "terminal_reply") return "check-small"
    if (value === "idle") return "circle-dot"
    if (value === "archived") return "archive"
    if (value === "running") return "status-active"
    if (value === "starting") return "status"
    if (value === "queued") return "hourglass"
    if (value === "rate_limited") return "status"
    if (value === "retry") return "reset"
    if (value === "waiting_user") return "prompt"
    if (value === "waiting_permission") return "shield"
    if (value === "waiting_child") return "hourglass"
    if (value === "paused") return "pause"
    if (value === "blocked") return "circle-ban-sign"
    if (value === "interrupted") return "warning"
    if (value === "aborting" || value === "aborted") return "stop"
    if (value === "timeout") return "warning"
    return "circle-x"
  })
  const tip = createMemo(() => `${type()} · ${props.label()}`)
  return (
    <Tooltip value={tip()} placement="top">
      <div
        class="relative shrink-0 size-5 flex items-center justify-center border bg-background-base"
        classList={{
          "rounded-full border-icon-success-base text-icon-success-base": done(),
          "rounded-full border-border-weak-base text-icon-weak bg-surface-base": idle(),
          "rounded-md border-border-interactive-base text-text-interactive-base": !done() && !idle() && !bad(),
          "rounded-sm border-icon-critical-base text-icon-critical-base bg-surface-critical-weak": bad(),
        }}
      >
        <Show when={active()}>
          <span class="absolute inset-0 rounded-md border border-text-interactive-base opacity-20 animate-ping motion-reduce:animate-none" />
        </Show>
        <Icon
          name={icon()}
          size="small"
          classList={{
            "animate-spin motion-reduce:animate-none": type() === "retry",
            "animate-pulse motion-reduce:animate-none": type() === "queued" || type() === "paused",
          }}
        />
        <Show when={props.unseenCount() > 0}>
          <span class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-text-interactive-base" />
        </Show>
      </div>
    </Tooltip>
  )
}
const filters: SessionFilter[] = ["active", "waiting", "success", "failed", "stopped"]

const filterLabel = (filter: SessionFilter) => {
  if (filter === "active") return "活跃"
  if (filter === "waiting") return "等待"
  if (filter === "success") return "成功"
  if (filter === "failed") return "失败"
  return "停止"
}

export const SessionFilterBar = (props: {
  filter: Accessor<SessionFilter | undefined>
  setFilter: (filter: SessionFilter | undefined) => void
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
    <For each={filters}>
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

const treeX = (depth: number | undefined) => 18 + (depth ?? 0) * indent
const mid = (dense?: boolean) => (dense ? "12px" : "14px")
const line = { "background-color": "var(--border-strong-base)" }

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
  guides?: boolean[]
  childCount?: number
  index?: number
  expanded?: Accessor<Record<string, boolean>>
  lineage?: Accessor<Set<string>>
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
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  titleLabel: Accessor<string>
  titleTip: Accessor<string>
  agentLabel: Accessor<string | undefined>
  childSummary: Accessor<{ completed: number; total: number; working: number } | undefined>
  slug: string
  mobile?: boolean
  dense?: boolean
  status: Accessor<string | undefined>
  unseenCount: Accessor<number>
  durationLabel: Accessor<string>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  depth?: number
  isActive: Accessor<boolean>
  canExpand?: Accessor<boolean>
  expanded?: Accessor<boolean>
  toggle?: () => void
}): JSX.Element => (
  <div class="flex h-full min-w-0 flex-1 items-center" style={{ "padding-left": `${(props.depth ?? 0) * indent}px` }}>
    <Show when={props.canExpand?.()} fallback={<span class="shrink-0 size-5" aria-hidden="true" />}>
      <button
        type="button"
        class="shrink-0 size-5 rounded border border-transparent flex items-center justify-center text-icon-base bg-transparent focus:outline-none focus-visible:border-border-interactive-base focus-visible:bg-surface-base-active"
        classList={{
          "hover:bg-surface-base-hover hover:border-border-weak-base": true,
          "text-text-interactive-base border-border-interactive-base": props.expanded?.(),
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
      class={`flex h-full min-w-0 flex-1 items-center gap-2 pr-2 text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        props.setHoverSession(undefined)
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <StatusBadge label={props.durationLabel} status={props.status} unseenCount={props.unseenCount} />
      <span data-session-title class="flex-1 min-w-0 overflow-hidden">
        <Tooltip value={props.titleTip()} placement="top" class="w-full min-w-0 overflow-hidden">
          <span
            data-session-title-text
            class="block w-fit max-w-full truncate rounded-sm px-1 -mx-1 text-14-regular text-text-strong transition-colors"
            classList={{
              "bg-surface-base-active": props.isActive(),
            }}
          >
            {props.titleLabel()}
          </span>
        </Tooltip>
      </span>
      <Show when={props.agentLabel()}>
        {(agent) => <span class="shrink-0 text-12-regular text-text-weak">({agent()})</span>}
      </Show>
      <Show when={props.childSummary()}>
        {(summary) => (
          <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-11-regular tabular-nums text-text-weak">
            {summary().completed}/{summary().total}
          </span>
        )}
      </Show>
    </A>
  </div>
)

const TreeLines = (props: {
  depth?: number
  dense?: boolean
  expanded: Accessor<boolean>
  childCount: Accessor<number>
  guides?: boolean[]
  last?: boolean
}): JSX.Element => {
  const depth = () => props.depth ?? 0
  return (
    <>
      <For each={(props.guides ?? []).slice(0, Math.max(0, depth() - 1))}>
        {(guide, index) => (
          <Show when={guide}>
            <div
              class="pointer-events-none absolute top-0 bottom-0 w-px z-[2]"
              style={{ left: `${treeX(index())}px`, ...line }}
            />
          </Show>
        )}
      </For>
      <Show when={depth() > 0}>
        <div
          class="pointer-events-none absolute top-0 w-px z-[2]"
          style={{ left: `${treeX(depth() - 1)}px`, height: mid(props.dense), ...line }}
        />
        <Show when={!props.last}>
          <div
            class="pointer-events-none absolute bottom-0 w-px z-[2]"
            style={{ left: `${treeX(depth() - 1)}px`, top: mid(props.dense), ...line }}
          />
        </Show>
        <div
          class="pointer-events-none absolute h-px z-[2]"
          style={{ top: mid(props.dense), left: `${treeX(depth() - 1)}px`, width: `${indent}px`, ...line }}
        />
      </Show>
      <Show when={props.expanded() && props.childCount() > 0}>
        <div
          class="pointer-events-none absolute bottom-0 w-px z-[2]"
          style={{ left: `${treeX(depth())}px`, top: mid(props.dense), ...line }}
        />
      </Show>
    </>
  )
}

const SessionHoverPreview = (props: {
  mobile?: boolean
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  session: Session
  sidebarHovering: Accessor<boolean>
  hoverMessages: Accessor<UserMessage[] | undefined>
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
  const messages = createMemo(() => sessionStore.message[props.session.id])
  const view = createMemo(
    () => {
      const status = sessionStore.session_status[props.session.id]
      const list = messages()
      const blocked = !!sessionPermissionRequest(
        sessionStore.session,
        sessionStore.permission,
        props.session.id,
        (item) => !permission.autoResponds(item, props.session.directory),
      )
      const paused = blocked || status?.type === "waiting_user" || status?.type === "waiting_permission"
      const working = !paused && sessionWorking(list, status)
      const childSummary = props.childSummary?.get(props.session.id)
      let agent: string | undefined
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          const item = list[i]
          if (item.role === "user" && item.agent) {
            agent = item.agent
            break
          }
        }
      }
      return {
        status: status?.type,
        isWorking: working,
        agent,
        childSummary: childSummary && childSummary.total > 0 ? childSummary : undefined,
      }
    },
    undefined,
    {
      equals: (a, b) => {
        if (a === b) return true
        if (!a || !b) return false
        return (
          a.status === b.status &&
          a.isWorking === b.isWorking &&
          a.agent === b.agent &&
          a.childSummary === b.childSummary
        )
      },
    },
  )
  const status = createMemo(() => view().status)
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!view().isWorking) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(id))
  })

  const agent = createMemo(() => sessionAgentLabel(props.session, agentLabelByName(view().agent, sessionStore.agent)))
  const durationLabel = createMemo(() => duration(props.session, messages(), view().isWorking, now()))

  const hoverMessages = createMemo(() => messages()?.filter((m): m is UserMessage => m.role === "user"))
  const hoverReady = createMemo(() => hoverMessages() !== undefined)
  const hoverAllowed = createMemo(() => !props.mobile && props.sidebarExpanded())
  const hoverEnabled = createMemo(() => (props.popover ?? true) && hoverAllowed() && hoverReady())
  const isActive = createMemo(() => props.session.id === params.id)
  const title = createMemo(() => {
    if (!props.session.parentID) return displaySessionTitle(props.session)
    return displaySessionTitle(props.session, props.index)
  })
  const titleTip = createMemo(() => {
    const base = title()
    const a = agentLabelByName(view().agent, sessionStore.agent)
    return a ? `${base} (${a})` : base
  })
  const canExpand = createMemo(() => (props.childCount ?? 0) > 0)
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

  const messageLabel = (message: Message) => {
    const parts = sessionStore.part[message.id] ?? []
    const text = parts.find((part): part is TextPart => part?.type === "text" && !part.synthetic && !part.ignored)
    return text?.text
  }
  const item = (
    <SessionRow
      session={props.session}
      titleLabel={title}
      titleTip={titleTip}
      agentLabel={agent}
      childSummary={() => view().childSummary}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      status={status}
      unseenCount={unseenCount}
      durationLabel={durationLabel}
      setHoverSession={props.setHoverSession}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      depth={props.depth}
      canExpand={canExpand}
      isActive={isActive}
      expanded={expanded}
      toggle={toggle}
    />
  )

  return (
    <div
      class="relative h-[30px]"
      classList={{
        "border-t border-border-weaker-base": !props.session.parentID && props.first === false,
      }}
    >
      <TreeLines
        depth={props.depth}
        dense={props.dense}
        expanded={expanded}
        childCount={() => props.childCount ?? 0}
        guides={props.guides}
        last={props.last}
      />
      <div
        data-session-id={props.session.id}
        class="group/session relative z-[1] flex h-full w-full min-w-0 items-center rounded-md cursor-default pl-2 pr-1 transition-colors
             hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover"
      >
        <div class="min-w-0 flex-1">
          <Show
            when={hoverEnabled()}
            fallback={
              <Tooltip placement={props.mobile ? "bottom" : "right"} value={titleTip()} gutter={10}>
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
              hoverMessages={hoverMessages}
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
        </div>
        <div
          class="flex h-full shrink-0 items-center gap-0.5 overflow-hidden transition-[width,opacity] duration-150 ease-out motion-reduce:transition-none"
          classList={{
            "w-[52px] opacity-100 pointer-events-auto": !!props.mobile,
            "w-0 opacity-0 pointer-events-none": !props.mobile,
            "group-hover/session:w-[52px] group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
            "group-focus-within/session:w-[52px] group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
          }}
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
