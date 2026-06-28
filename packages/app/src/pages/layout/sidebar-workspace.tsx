import { useNavigate, useParams } from "@solidjs/router"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@open-agent-harness/util/encode"
import { getFilename } from "@open-agent-harness/util/path"
import { Button } from "@open-agent-harness/ui/button"
import { Collapsible } from "@open-agent-harness/ui/collapsible"
import { DropdownMenu } from "@open-agent-harness/ui/dropdown-menu"
import { Icon } from "@open-agent-harness/ui/icon"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { Spinner } from "@open-agent-harness/ui/spinner"
import { Tooltip } from "@open-agent-harness/ui/tooltip"
import { type Session } from "@open-agent-harness/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { NewSessionItem, SessionFilterBar, SessionItem, SessionSkeleton } from "./sidebar-items"
import {
  childMapByParent,
  childSummaryBySession,
  effectiveSessionExpansion,
  sessionFilter,
  type SessionFilter,
  sessionLineage,
  sessionScrollRestore,
  sessionScrollWrite,
  sortedRootSessions,
  visibleSessionTree,
} from "./helpers"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  archiveSession: (session: Session) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  sessionScroll: (directory: string) => number
  setSessionScroll: (directory: string, top: number) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

const indent = 24
const treeX = (depth: number) => 18 + depth * indent
const line = { "background-color": "var(--border-strong-base)" }

const TreeSpacer = (props: {
  height: number
  item: ReturnType<typeof visibleSessionTree>[number] | undefined
  tail?: boolean
}): JSX.Element => {
  const marks = createMemo(() => {
    const item = props.item
    if (!item) return []
    const set = new Set<number>()
    item.guides.forEach((guide, index) => {
      if (guide) set.add(index)
    })
    if (!props.tail && item.depth > 0 && !item.first) set.add(item.depth - 1)
    if (props.tail && item.depth > 0 && !item.last) set.add(item.depth - 1)
    return [...set].sort((a, b) => a - b)
  })

  return (
    <div class="relative" style={{ height: `${props.height}px` }}>
      <For each={marks()}>
        {(depth) => (
          <div
            class="pointer-events-none absolute top-0 bottom-0 w-px z-[2]"
            style={{ left: `${treeX(depth)}px`, ...line }}
          />
        )}
      </For>
    </div>
  )
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = globalSync.child(directory, { bootstrap: false })
    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, workspaceStore.vcs?.branch, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <span class="text-14-medium text-text-base shrink-0">
      {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")} :
    </span>
    <Show
      when={!props.local()}
      fallback={
        <span class="text-14-medium text-text-base min-w-0 truncate">
          {props.branch() ?? getFilename(props.directory)}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base min-w-0 truncate"
        displayClass="text-14-medium text-text-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  sidebarHovering: Accessor<boolean>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  setHoverSession: WorkspaceSidebarContext["setHoverSession"]
  clearHoverProjectSoon: WorkspaceSidebarContext["clearHoverProjectSoon"]
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen(),
      "opacity-0 pointer-events-none": !props.menuOpen(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButton
          icon="new-session"
          variant="ghost"
          class="size-6 rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.setHoverSession(undefined)
            props.clearHoverProjectSoon()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

const WorkspaceSessionList = (props: {
  directory: string
  slug: Accessor<string>
  mobile?: boolean
  popover?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  all: Accessor<Session[]>
  children: Accessor<Map<string, string[]>>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const params = useParams()
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [scroll, setScroll] = createSignal(props.ctx.sessionScroll(props.directory))
  const [height, setHeight] = createSignal(0)
  let el: HTMLDivElement | undefined
  let restoring = false
  let settling = false
  let route = params.id
  const lineage = createMemo(() => sessionLineage(props.all(), params.id))
  const large = createMemo(() => props.all().length > 200)
  const open = createMemo(() => effectiveSessionExpansion(expanded, lineage()))
  const [filter, setFilter] = createSignal<SessionFilter | undefined>()
  const shown = createMemo(() => {
    const active = filter()
    if (!active) return
    const all = props.all()
    const dir = all[0]?.directory
    if (!dir) return new Set<string>()
    const [store] = globalSync.child(dir, { bootstrap: false })
    const by = new Map(all.map((session) => [session.id, session]))
    const children = props.children()
    const memo = new Map<string, boolean>()
    const matches = (session: Session) => {
      const status = store.session_status[session.id]
      const blocked = !!sessionPermissionRequest(store.session, store.permission, session.id, (item) => {
        return !permission.autoResponds(item, session.directory)
      })
      return sessionFilter({
        session,
        messages: store.message[session.id],
        status,
        blocked,
        error: notification.session.unseenHasError(session.id),
      }) === active
    }
    const keep = (id: string): boolean => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      const session = by.get(id)
      if (!session || session.time?.archived) {
        memo.set(id, false)
        return false
      }
      const value = matches(session) || (children.get(id) ?? []).some(keep)
      memo.set(id, value)
      return value
    }
    const ids = new Set<string>()
    for (const session of props.sessions()) {
      if (!keep(session.id)) continue
      for (const [id, value] of memo.entries()) {
        if (value) ids.add(id)
      }
    }
    return ids
  })
  const view = createMemo(() => {
    const ids = shown()
    if (ids) return new Set([...ids, ...open()])
    if (large()) return open()
    return new Set([...props.all().map((session) => session.id), ...open()])
  })
  const tree = createMemo(() => {
    const ids = shown()
    return visibleSessionTree(
      props.sessions(),
      props.all(),
      props.children(),
      view(),
      ids ? (session) => ids.has(session.id) : undefined,
    )
  })
  const nav = createMemo(() => tree().map((item) => item.session))
  const summary = createMemo(() => {
    const dir = props.all()[0]?.directory
    if (!dir) return new Map<string, { completed: number; total: number; working: number }>()
    const [store] = globalSync.child(dir, { bootstrap: false })
    const children = props.children()
    const parents = props.all().filter((session) => (children.get(session.id)?.length ?? 0) > 0)
    return childSummaryBySession(parents, children, store.message, store.session_status)
  })
  const set = (id: string, value: boolean) => setExpanded(id, value)
  const row = 30
  const over = 8
  const measure = () => setHeight(el?.clientHeight ?? 0)
  const target = () => sessionScrollRestore({ current: props.ctx.sessionScroll(props.directory) })
  const restore = () => {
    const top = target()
    if (!el || top <= 0) return
    restoring = true
    el.scrollTop = top
    setScroll(el.scrollTop)
    props.ctx.setSessionScroll(props.directory, el.scrollTop)
    requestAnimationFrame(() => {
      restoring = false
    })
  }
  const range = createMemo(() => {
    const count = tree().length
    const start = Math.max(0, Math.floor(scroll() / row) - over)
    const size = Math.ceil(height() / row) + over * 2
    const end = Math.min(count, start + size)
    return { start, end, count }
  })
  const slice = createMemo(() => tree().slice(range().start, range().end))

  onMount(() => {
    measure()
    restore()
    if (typeof ResizeObserver === "undefined" || !el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  })

  createEffect(() => {
    const id = params.id
    if (id === route) return
    route = id
    settling = true
    requestAnimationFrame(() => {
      if (el?.scrollTop === 0) restore()
      requestAnimationFrame(() => {
        settling = false
      })
    })
  })

  return (
    <nav class="flex min-h-0 flex-col gap-1 overflow-hidden pr-1">
      <Show when={props.showNew()}>
        <NewSessionItem
          slug={props.slug()}
          mobile={props.mobile}
          sidebarExpanded={props.ctx.sidebarExpanded}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
          setHoverSession={props.ctx.setHoverSession}
        />
      </Show>
      <SessionFilterBar filter={filter} setFilter={setFilter} />
      <Show when={props.loading()}>
        <SessionSkeleton />
      </Show>
      <div
        ref={el}
        class="min-h-0 max-h-[70vh] overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
        onScroll={(event) => {
          const top = sessionScrollWrite({
            top: event.currentTarget.scrollTop,
            current: scroll(),
            settling,
            restoring,
          })
          if (top === undefined) return
          setScroll(top)
          props.ctx.setSessionScroll(props.directory, top)
        }}
      >
        <TreeSpacer height={range().start * row} item={slice()[0]} />
        <For each={slice()}>
          {(item) => (
            <SessionItem
              session={item.session}
              list={props.all()}
              navList={nav}
              slug={props.slug()}
              mobile={props.mobile}
              popover={props.popover}
              expanded={() => expanded}
              lineage={lineage}
              setExpanded={set}
              children={props.children()}
              childSummary={summary()}
              guides={item.guides}
              childCount={item.childCount}
              collapseByDefault={large}
              sidebarExpanded={props.ctx.sidebarExpanded}
              sidebarHovering={props.ctx.sidebarHovering}
              nav={props.ctx.nav}
              hoverSession={props.ctx.hoverSession}
              setHoverSession={props.ctx.setHoverSession}
              clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
              archiveSession={props.ctx.archiveSession}
              depth={item.depth}
              first={item.first}
              last={item.last}
              index={item.index}
            />
          )}
        </For>
        <TreeSpacer height={(range().count - range().end) * row} item={slice().at(-1)} tail />
        <Show when={props.hasMore()}>
          <div class="relative w-full py-1">
            <Button
              variant="ghost"
              class="flex w-full text-left justify-start text-14-regular text-text-weak pl-9 pr-10"
              size="large"
              onClick={(e: MouseEvent) => {
                props.loadMore()
                ;(e.currentTarget as HTMLButtonElement).blur()
              }}
            >
              {props.language.t("common.loadMore")}
            </Button>
          </div>
        </Show>
      </div>
    </nav>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  mobile?: boolean
  popover?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const params = useParams()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [workspaceStore, setWorkspaceStore] = globalSync.child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() => sortedRootSessions(workspaceStore))
  const children = createMemo(() => childMapByParent(workspaceStore.session))
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => props.ctx.currentDir() === props.directory)
  const workspaceValue = createMemo(() => {
    const branch = workspaceStore.vcs?.branch
    const name = branch ?? getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, branch) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const boot = createMemo(() => open() || active())
  const booted = createMemo((prev) => prev || workspaceStore.status === "complete", false)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > sessions().length)
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const wasBusy = createMemo((prev) => prev || busy(), false)
  const loading = createMemo(() => open() && !booted() && sessions().length === 0 && !wasBusy())
  const touch = createMediaQuery("(hover: none)")
  const showNew = createMemo(() => !loading() && (touch() || sessions().length === 0 || (active() && !params.id)))
  const loadMore = async () => {
    setWorkspaceStore("limit", (limit) => (limit ?? 0) + 10)
    await globalSync.project.loadSessions(props.directory, { mode: "current", force: true })
  }

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => workspaceStore.vcs?.branch}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
      projectId={props.project.id}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  createEffect(() => {
    if (!boot()) return
    globalSync.child(props.directory, { bootstrap: true })
  })

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <Collapsible.Trigger
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-[padding] duration-200 ${
                      menu.open ? "pr-16" : "pr-2"
                    } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    {header()}
                  </Collapsible.Trigger>
                }
              >
                <div
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md transition-[padding] duration-200 ${
                    menu.open ? "pr-16" : "pr-2"
                  } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                >
                  {header()}
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                sidebarHovering={props.ctx.sidebarHovering}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                setHoverSession={props.ctx.setHoverSession}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => navigate(`/${slug()}/session`)}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <WorkspaceSessionList
            directory={props.directory}
            slug={slug}
            mobile={props.mobile}
            popover={props.popover}
            ctx={props.ctx}
            showNew={showNew}
            loading={loading}
            sessions={sessions}
            all={() => workspaceStore.session}
            children={children}
            hasMore={hasMore}
            loadMore={loadMore}
            language={language}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  mobile?: boolean
  popover?: boolean
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const workspace = createMemo(() => {
    const [store, setStore] = globalSync.child(props.project.worktree)
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store))
  const children = createMemo(() => childMapByParent(workspace().store.session))
  const booted = createMemo((prev) => prev || workspace().store.status === "complete", false)
  const loading = createMemo(() => !booted() && sessions().length === 0)
  const hasMore = createMemo(() => workspace().store.sessionTotal > sessions().length)
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 10)
    await globalSync.project.loadSessions(props.project.worktree, { mode: "current", force: true })
  }

  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto [overflow-anchor:none]"
    >
      <WorkspaceSessionList
        directory={props.project.worktree}
        slug={slug}
        mobile={props.mobile}
        popover={props.popover}
        ctx={props.ctx}
        showNew={() => false}
        loading={loading}
        sessions={sessions}
        all={() => workspace().store.session}
        children={children}
        hasMore={hasMore}
        loadMore={loadMore}
        language={language}
      />
    </div>
  )
}
