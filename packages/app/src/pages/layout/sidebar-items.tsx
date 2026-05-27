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
import { type Accessor, createMemo, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { childSessionSummary, displaySessionTitle, hasProjectPermissions, sessionCompleted, sessionWorking } from "./helpers"

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

const RunningIcon = (): JSX.Element => (
  <div class="relative size-5 flex items-center justify-center text-icon-info-active" aria-label="Running" title="Running">
    <span class="absolute size-4 rounded-full border border-icon-info-active opacity-30 animate-ping motion-reduce:animate-none" />
    <span class="absolute size-3 rounded-full bg-icon-info-active opacity-10 animate-pulse motion-reduce:animate-none" />
    <Icon
      name="reset"
      size="small"
      class="relative text-icon-info-active animate-spin [animation-duration:1.1s] motion-reduce:animate-none"
    />
  </div>
)

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
  expanded?: Accessor<Record<string, boolean>>
  lineage?: Accessor<Set<string>>
  setExpanded?: (id: string, value: boolean) => void
  children: Map<string, string[]>
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
  childSummary: Accessor<{ completed: number; total: number } | undefined>
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  isPaused: Accessor<boolean>
  isDone: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
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
  <div class="flex items-center min-w-0" style={{ "padding-left": `${(props.depth ?? 0) * 14}px` }}>
    <Show when={props.canExpand?.()} fallback={<span class="shrink-0 size-5" aria-hidden="true" />}>
      <button
        type="button"
        class="shrink-0 size-5 rounded flex items-center justify-center text-icon-weak hover:bg-surface-base-hover focus:outline-none focus-visible:bg-surface-base-active"
        aria-expanded={props.expanded?.() ?? false}
        aria-label="Toggle session children"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.toggle?.()
        }}
      >
        <Icon name={props.expanded?.() ? "chevron-down" : "chevron-right"} size="small" />
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
        <div
          class="shrink-0 size-6 flex items-center justify-center"
          style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch fallback={<div class="size-1.5 rounded-full bg-icon-weak-base" aria-label="Idle" title="Idle" />}>
            <Match when={props.isPaused()}>
              <Icon name="stop" size="small" class="text-icon-warning-base" aria-label="Paused" />
            </Match>
            <Match when={props.isWorking()}>
              <RunningIcon />
            </Match>
            <Match when={props.hasPermissions()}>
              <Icon name="warning" size="small" class="text-icon-warning-base" aria-label="Permission required" />
            </Match>
            <Match when={props.hasError()}>
              <Icon name="circle-x" size="small" class="text-icon-critical-base" aria-label="Error" />
            </Match>
            <Match when={props.isDone()}>
              <Icon name="circle-check" size="small" class="text-text-diff-add-base" aria-label="Done" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
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
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = globalSync.child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const status = createMemo(() => sessionStore.session_status[props.session.id])
  const isPaused = createMemo(() => {
    const next = status()?.type
    return hasPermissions() || next === "waiting_user" || next === "waiting_permission"
  })
  const isWorking = createMemo(() => {
    if (isPaused()) return false
    return sessionWorking(sessionStore.message[props.session.id], status())
  })
  const isDone = createMemo(() => {
    if (hasPermissions() || isWorking() || hasError()) return false
    return sessionCompleted(props.session, sessionStore.message[props.session.id], status())
  })

  const tint = createMemo(() => {
    return messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent)
  })

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
  const title = createMemo(() => {
    if (!props.session.parentID) return displaySessionTitle(props.session)
    const ids = props.children.get(props.session.parentID) ?? []
    const idx = ids
      .filter((id) => props.list.some((session) => session.id === id && !session.time?.archived))
      .indexOf(props.session.id)
    return displaySessionTitle(props.session, idx === -1 ? undefined : idx)
  })
  const childSummary = createMemo(() => {
    const children = childSessions()
    return childSessionSummary(children, sessionStore.message, sessionStore.session_status)
  })
  const canExpand = createMemo(() => childSessions().length > 0)
  const expanded = createMemo(() => !!props.expanded?.()[props.session.id] || !!props.lineage?.().has(props.session.id))
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
      isWorking={isWorking}
      isPaused={isPaused}
      isDone={isDone}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
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
    <div>
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
        <For each={childSessions()}>
          {(session) => <SessionItem {...props} session={session} depth={(props.depth ?? 0) + 1} />}
        </For>
      </Show>
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
