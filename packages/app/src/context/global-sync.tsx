import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  Session,
  Todo,
} from "@open-agent-harness/sdk/v2/client"
import { showToast } from "@open-agent-harness/ui/toast"
import { getFilename } from "@open-agent-harness/util/path"
import {
  createContext,
  getOwner,
  Match,
  onCleanup,
  onMount,
  type ParentProps,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import type { InitError } from "../pages/error"
import { useGlobalSDK } from "./global-sdk"
import { bootstrapDirectory, bootstrapGlobal } from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { createRefreshQueue } from "./global-sync/queue"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadSessionTreeWithFallback, mergeSessionStatus } from "./global-sync/session-load"
import type { ProjectMeta, RootLoadArgs } from "./global-sync/types"
import { sanitizeProject } from "./global-sync/utils"
import { formatServerError } from "@/utils/server-errors"

type LoadMode = "current" | "running"

const INITIAL_SESSION_LIMIT = 10
const live = new Set(["queued", "rate_limited", "retry", "running", "starting", "waiting_permission", "waiting_user", "waiting_child"])

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number; mode: LoadMode; roots: Set<string> }>()

  const [projectCache, setProjectCache, projectInit] = persisted(
    Persist.global("globalSync.project", ["globalSync.project.v1"]),
    createStore({ value: [] as Project[] }),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: projectCache.value,
    session_todo: {},
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    config: {},
    reload: undefined,
  })

  let active = true
  let projectWritten = false

  onCleanup(() => {
    active = false
  })

  const cacheProjects = () => {
    setProjectCache(
      "value",
      untrack(() => globalStore.project.map(sanitizeProject)),
    )
  }

  const setProjects = (next: Project[] | ((draft: Project[]) => void)) => {
    projectWritten = true
    if (typeof next === "function") {
      setGlobalStore("project", produce(next))
      cacheProjects()
      return
    }
    setGlobalStore("project", next)
    cacheProjects()
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => void))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  if (projectInit instanceof Promise) {
    void projectInit.then(() => {
      if (!active) return
      if (projectWritten) return
      const cached = projectCache.value
      if (cached.length === 0) return
      setGlobalStore("project", cached)
    })
  }

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => [...sessionLoads.keys()].some((key) => key.startsWith(`${directory}:`)),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      queue.clear(directory)
      sessionMeta.delete(directory)
      sdkCache.delete(directory)
      clearSessionPrefetchDirectory(directory)
    },
    translate: language.t,
  })

  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached
    const sdk = globalSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, sdk)
    return sdk
  }

  async function runningRoots(directory: string, status: Record<string, { type?: string }>) {
    const roots: Session[] = []
    const seen = new Set<string>()
    const ids = Object.entries(status)
      .filter((item) => live.has(item[1]?.type ?? "idle"))
      .map((item) => item[0])

    for (const id of ids) {
      let next = id
      const walk = new Set<string>()
      while (next && !walk.has(next)) {
        walk.add(next)
        const session = await globalSDK.client.session
          .get({ directory, sessionID: next })
          .then((x) => x.data)
          .catch(() => undefined)
        if (!session || session.time?.archived) break
        if (session.parentID) {
          next = session.parentID
          continue
        }
        if (seen.has(session.id)) break
        seen.add(session.id)
        roots.push(session)
        break
      }
      if (roots.length >= INITIAL_SESSION_LIMIT) break
    }

    return roots.sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
  }

  async function loadSessions(directory: string, opts?: { mode?: LoadMode; force?: boolean }) {
    const mode = opts?.mode ?? "current"
    const force = opts?.force === true
    const key = `${directory}:${mode}`
    const pending = sessionLoads.get(key)
    if (pending) return pending

    children.pin(directory)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (!force && mode === "running" && meta?.mode === "current") {
      children.unpin(directory)
      return
    }

    const limit = mode === "running" ? INITIAL_SESSION_LIMIT : Math.max(store.limit, INITIAL_SESSION_LIMIT)
    if (!force && meta?.mode === mode && meta.limit >= limit) {
      children.unpin(directory)
      return
    }

    const promise = (async () => {
      const status = mode === "running" ? await globalSDK.client.session.status().then((x) => x.data ?? {}) : undefined
      if (status) setStore("session_status", reconcile(status))
      const base = status ? await runningRoots(directory, status) : undefined
      const list: RootLoadArgs["list"] = async (query) => {
        if (base) return { data: base }
        return globalSDK.client.session.list(query)
      }

      const x = await loadSessionTreeWithFallback({
        directory,
        limit: base ? base.length : limit,
        children: true,
        loaded: !force && meta?.mode === mode ? meta.roots : undefined,
        list,
        tree: (query) => globalSDK.client.session.tree(query),
        descendants: (query) =>
          globalSDK.client.session.descendantsBatch({
            body_directory: query.directory,
            ids: query.ids,
          }),
      })
      const nonArchived = (x.data ?? [])
        .filter((s) => !!s?.id)
        .filter((s) => !s.time?.archived)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const roots = nonArchived.filter((s) => !s.parentID)
      const ids = new Set(nonArchived.map((s) => s.id))
      const childSessions = store.session.filter((s) => !!s.parentID && !ids.has(s.id))
      const sessions = [...nonArchived, ...childSessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      if (mode === "running" && sessionMeta.get(directory)?.mode === "current") return
      setStore("session_status", reconcile(mergeSessionStatus(store.session_status, x.status)))
      setStore(
        "sessionTotal",
        mode === "running"
          ? roots.length
          : estimateRootSessionTotal({
              count: roots.length,
              limit: store.limit,
              limited: x.limited,
            }),
      )
      setStore("session", reconcile(sessions, { key: "id" }))
      cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo)
      sessionMeta.set(directory, { limit, mode, roots: new Set(x.ids) })
    })().catch((err) => {
      console.error("Failed to load sessions", err)
      const project = getFilename(directory)
      showToast({
        variant: "error",
        title: language.t("toast.session.listFailed.title", { project }),
        description: formatServerError(err, language.t),
      })
    })

    sessionLoads.set(key, promise)
    promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(directory)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    children.pin(directory)
    const promise = (async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(directory)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
      })
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: queue.refresh,
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[directory]
    if (!existing) return
    children.mark(directory)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: (directory) => {
        sessionMeta.delete(directory)
        queue.push(directory)
      },
      setSessionTodo,
      vcsCache: children.vcsCache.get(directory),
      loadLsp: () => {
        sdkFor(directory)
          .lsp.status()
          .then((x) => setStore("lsp", x.data ?? []))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directory)
    }
  })

  async function bootstrap() {
    await bootstrapGlobal({
      globalSDK: globalSDK.client,
      connectErrorTitle: language.t("dialog.server.add.error"),
      connectErrorDescription: language.t("error.globalSync.connectFailed", {
        url: globalSDK.url,
      }),
      requestFailedTitle: language.t("common.requestFailed"),
      translate: language.t,
      formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
      setGlobalStore: setBootStore,
    })
  }

  onMount(() => {
    void bootstrap()
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfig = async (config: Config) => {
    setGlobalStore("reload", "pending")
    return globalSDK.client.global.config
      .update({ config })
      .then(bootstrap)
      .then(() => {
        queue.refresh()
        setGlobalStore("reload", undefined)
        queue.refresh()
      })
      .catch((error) => {
        setGlobalStore("reload", undefined)
        throw error
      })
  }

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    bootstrap,
    updateConfig,
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
