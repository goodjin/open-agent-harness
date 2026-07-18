import { describe, expect, test } from "bun:test"
import type { SessionTaskCurrentResponse, SessionTaskRevisionResponse } from "@open-agent-harness/sdk/v2/client"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import {
  action,
  choose,
  compact,
  content,
  handoff,
  initial,
  observe,
  progress,
  refresh,
  requests,
  single,
  stamp,
  view,
  watch,
  type Badge,
  type Feed,
} from "./session-task-data"

const task = (value: Partial<SessionTaskCurrentResponse> = {}) =>
  ({
    id: "task_1",
    session_id: "session_1",
    title: "Ship the task view",
    version: 1,
    status: "running",
    body: "# Task",
    progress: { completed: 1, total: 3 },
    actions: [],
    handoffs: [],
    time: { created: 1, updated: 2 },
    ...value,
  }) as SessionTaskCurrentResponse

const revision = (value: Partial<SessionTaskRevisionResponse> = {}) =>
  ({
    id: "revision_1",
    session_id: "session_1",
    title: "Archived task",
    version: 1,
    status: "archived",
    body: "# Archived",
    workflow: { actions: [], compact: { runs: 2, completed: 3, total: 4 } },
    actions: [],
    handoffs: [],
    reason: null,
    archive_reason: "Revised",
    time: { created: 1, archived: 2 },
    ...value,
  }) as SessionTaskRevisionResponse

const deferred = <T>() => {
  let resolve = (_value: T) => {}
  let reject = (_error: unknown) => {}
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("session task", () => {
  test("maps unbound and active task statuses", () => {
    expect(view()).toMatchObject({ status: "unbound", showResult: false })
    expect(view(task())).toMatchObject({ status: "running", showResult: false })
    expect(view(task({ status: "revising" }))).toMatchObject({ status: "revising", showResult: false })
  })

  test("shows terminal task results without guessing from actions", () => {
    expect(view(task({ status: "completed", result: "Done", result_source: "protocol" }))).toMatchObject({
      status: "completed",
      result: "recorded",
      showResult: true,
    })
    expect(view(task({ status: "blocked", result: "Partial", result_source: "fallback_summary" }))).toMatchObject({
      status: "blocked",
      result: "fallback",
      showResult: true,
    })
    expect(view(task({ status: "failed" }))).toMatchObject({
      status: "failed",
      result: "missing",
      showResult: true,
    })
    expect(view(task({ status: "completed", result: "Unattributed" }))).toMatchObject({ result: "missing" })
    expect(view(task({ status: "completed", result_source: "fallback_summary" }))).toMatchObject({
      result: "missing",
    })
    expect(content(task({ status: "completed", result: "Unattributed" }))).toBeUndefined()
    expect(content(task({ status: "completed", result: "Trusted", result_source: "protocol" }))).toBe("Trusted")
    expect(
      content(
        revision({ result: "Unclassified action result", result_source: "action_result" }),
      ),
    ).toBeUndefined()
    expect(
      view(task({ status: "completed", result: "Trusted", result_source: "action_result" })).result,
    ).toBe("recorded")
  })

  test("uses completed plus skipped actions and compact history progress", () => {
    expect(
      progress(
        revision({
          actions: [{ status: "completed" }, { status: "skipped" }, { status: "failed" }] as never,
        }),
      ),
    ).toEqual({ completed: 5, total: 7 })
    expect(progress(task({ progress: { completed: 4, total: 9 } }))).toEqual({ completed: 4, total: 9 })
  })

  test("maps action and handoff statuses to bilingual labels", () => {
    expect(en[action("skipped")]).toBe("Skipped")
    expect(zh[action("skipped")]).toBe("已跳过")
    expect(en[handoff("failed")]).toBe("Failed")
    expect(zh[handoff("failed")]).toBe("失败")
  })

  test("drops every old session request after reset", async () => {
    const loader = requests()
    const values: string[] = []
    const current = deferred<string>()
    const history = deferred<string>()
    const detail = deferred<string>()
    const signals: AbortSignal[] = []
    const pending = [
      loader.run(
        "current",
        (signal) => (signals.push(signal), current.promise),
        (value) => values.push(value),
      ),
      loader.run(
        "history",
        (signal) => (signals.push(signal), history.promise),
        (value) => values.push(value),
      ),
      loader.run(
        "detail",
        (signal) => (signals.push(signal), detail.promise),
        (value) => values.push(value),
      ),
    ]

    loader.reset()
    current.resolve("old current")
    history.resolve("old history")
    detail.resolve("old detail")
    await Promise.all(pending)

    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(values).toEqual([])
  })

  test("keeps only the latest repeated current and revision request", async () => {
    const loader = requests()
    const values: string[] = []
    const first = deferred<string>()
    const second = deferred<string>()
    const old = loader.run(
      "current",
      () => first.promise,
      (value) => values.push(value),
    )
    const fresh = loader.run(
      "current",
      () => second.promise,
      (value) => values.push(value),
    )
    first.resolve("old current")
    second.resolve("new current")
    await Promise.all([old, fresh])

    const v1 = deferred<string>()
    const v2 = deferred<string>()
    const oldRevision = loader.run(
      "detail",
      () => v1.promise,
      (value) => values.push(value),
    )
    const newRevision = loader.run(
      "detail",
      () => v2.promise,
      (value) => values.push(value),
    )
    v2.resolve("revision 2")
    v1.resolve("revision 1")
    await Promise.all([oldRevision, newRevision])

    expect(values).toEqual(["new current", "revision 2"])
  })

  test("refreshes while mounted and clears its timer on cleanup", () => {
    let tick = () => {}
    let cleared = false
    const calls: number[] = []
    const stop = refresh(
      () => calls.push(1),
      25,
      {
        set(fn, delay) {
          tick = fn
          expect(delay).toBe(25)
          return 7
        },
        clear(id) {
          expect(id).toBe(7)
          cleared = true
        },
      },
    )
    tick()
    tick()
    stop()
    expect(calls).toHaveLength(2)
    expect(cleared).toBe(true)
  })

  test("does not starve a slow current request across poll and status refreshes", async () => {
    const loader = requests()
    const first = deferred<SessionTaskCurrentResponse>()
    const second = deferred<SessionTaskCurrentResponse>()
    const old = deferred<SessionTaskCurrentResponse>()
    const next = deferred<SessionTaskCurrentResponse>()
    const queues = { session_1: [first, second, old], session_2: [next] }
    const signals: AbortSignal[] = []
    let local: Badge | undefined
    let tick = () => {}
    let listener = (_event: { properties: { sessionID: string } }) => {}
    let calls = 0
    const load = (sessionID: string) =>
      loader.run(
        "current",
        (signal) => {
          calls++
          signals.push(signal)
          return queues[sessionID as keyof typeof queues].shift()!.promise
        },
        (value) => {
          local = { sessionID, value: compact(value) }
        },
      )
    const flight = single(load, loader.reset)
    const poll = refresh(() => flight.refresh("session_1"), 25, {
      set(fn) {
        tick = fn
        return 1
      },
      clear() {},
    })
    const bind = watch(
      (_type, fn) => {
        listener = fn
        return () => {}
      },
      (sessionID) => flight.refresh(sessionID),
    )

    bind("session_1")
    void flight.change("session_1")
    await Promise.resolve()
    await Promise.resolve()
    expect(choose("session_1", local)).toBeUndefined()
    tick()
    tick()
    listener({ properties: { sessionID: "session_1" } })
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(signals[0]?.aborted).toBe(false)
    first.resolve(task({ status: "running" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("running")
    expect(calls).toBe(2)
    second.resolve(task({ status: "completed" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("completed")
    expect(
      choose("session_1", { sessionID: "session_1", value: undefined }, compact(task({ status: "completed" }))),
    ).toBeUndefined()

    void flight.refresh("session_1")
    await Promise.resolve()
    await Promise.resolve()
    const fallback = compact(task({ id: "task_2", session_id: "session_2", status: "waiting_user" }))
    void flight.change("session_2")
    expect(signals[2]?.aborted).toBe(true)
    expect(choose("session_2", local, fallback)?.status).toBe("waiting_user")
    old.resolve(task({ status: "failed" }))
    next.resolve(task({ id: "task_2", session_id: "session_2", status: "running" }))
    await Bun.sleep(0)
    expect(calls).toBe(4)
    expect(choose("session_2", local)?.status).toBe("running")

    poll()
    bind()
    flight.stop()
  })

  test("updates the timeline badge with bounded refreshes without mounting the task tab", async () => {
    const missing = deferred<SessionTaskCurrentResponse>()
    const running = deferred<SessionTaskCurrentResponse>()
    const completed = deferred<SessionTaskCurrentResponse>()
    const error = deferred<SessionTaskCurrentResponse>()
    const old = deferred<SessionTaskCurrentResponse>()
    const next = deferred<SessionTaskCurrentResponse>()
    const queues = { session_1: [missing, running, completed, error, old], session_2: [next] }
    const signals: AbortSignal[] = []
    const listeners = new Set<(event: { properties: { sessionID: string } }) => void>()
    let tick = () => {}
    let local: Feed | undefined
    let calls = 0
    const monitor = observe({
      on(type, fn) {
        expect(type).toBe("session.status")
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      load(sessionID, signal) {
        calls++
        signals.push(signal)
        return queues[sessionID as keyof typeof queues].shift()!.promise
      },
      done(value) {
        local = value
      },
      missing: (err) => (err as { status?: number }).status === 404,
      error: () => "Failed",
      delay: 25,
      timers: {
        set(fn) {
          tick = fn
          return 1
        },
        clear() {},
      },
    })
    const event = (sessionID: string) =>
      listeners.forEach((fn) => fn({ properties: { sessionID } }))

    monitor.change("session_1")
    await Promise.resolve()
    await Promise.resolve()
    missing.reject({ status: 404 })
    await Bun.sleep(0)
    expect(choose("session_1", local)).toBeUndefined()

    event("session_1")
    tick()
    tick()
    event("session_1")
    await Bun.sleep(0)
    expect(calls).toBe(2)
    expect(signals[1]?.aborted).toBe(false)
    running.resolve(task({ status: "running" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("running")
    expect(local?.current?.body).toBe("# Task")
    expect(calls).toBe(3)
    completed.resolve(task({ status: "completed" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("completed")

    event("session_1")
    await Promise.resolve()
    error.reject({ status: 500 })
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("completed")

    event("session_1")
    await Bun.sleep(0)
    local = undefined
    monitor.change("session_2")
    expect(signals[4]?.aborted).toBe(true)
    old.resolve(task({ status: "failed" }))
    next.resolve(task({ id: "task_2", session_id: "session_2", status: "running" }))
    await Bun.sleep(0)
    expect(calls).toBe(6)
    expect(choose("session_2", local)?.status).toBe("running")
    expect(listeners.size).toBe(1)

    monitor.stop()
    expect(listeners.size).toBe(0)
  })

  test("rebinds the mounted task listener when its session prop changes", () => {
    const listeners = new Set<(event: { properties: { sessionID: string } }) => void>()
    const calls: string[] = []
    const bind = watch(
      (type, fn) => {
        expect(type).toBe("session.status")
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      (sessionID) => calls.push(sessionID),
    )
    const emit = (sessionID: string) =>
      listeners.forEach((listener) => listener({ properties: { sessionID } }))

    expect(typeof bind).toBe("function")
    bind("session_1")
    emit("session_1")
    bind("session_2")
    expect(listeners.size).toBe(1)
    emit("session_1")
    emit("session_2")
    bind()
    emit("session_2")

    expect(calls).toEqual(["session_1", "session_2"])
    expect(listeners.size).toBe(0)
  })

  test("formats task timestamps with the active language locale", () => {
    const value = Date.UTC(2026, 6, 18, 12, 30)
    expect(stamp(value, "zh-CN")).toBe(
      new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value),
    )
    expect(stamp(value, "en-US")).toBe(
      new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(value),
    )
  })

  test("starts with current, history, and revision state cleared", () => {
    expect(initial()).toEqual({
      current: undefined,
      history: { loaded: false, items: [] },
      detail: undefined,
      loading: { current: true, history: false, detail: false },
      error: { current: undefined, history: undefined, detail: undefined },
    })
  })

  test("receives current externally and loads history details only from explicit actions", async () => {
    const src = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()

    expect(src).not.toContain("sdk.client.session.task.current")
    expect(src).toContain("const feed = props.feed")
    expect(src).toContain("sdk.client.session.task.history")
    expect(src).toContain("sdk.client.session.task.revision")
    expect(src).toContain("createEffect")
    expect(src).toContain("onClick={() => void history()}")
    expect(src).toContain("onClick={() => void revision(item.version)}")
  })

  test("renders the task in the required order and keeps history read only", async () => {
    const src = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()
    const title = src.indexOf('language.t("session.task.current")')
    const body = src.indexOf("<Markdown text={task().body}")
    const progress = src.indexOf('language.t("session.task.progress")')
    const result = src.indexOf('language.t("session.task.result")')
    const handoff = src.indexOf('language.t("session.task.handoffs")')

    expect([title, body, progress, result, handoff].every((item) => item >= 0)).toBe(true)
    expect(title).toBeLessThan(body)
    expect(body).toBeLessThan(progress)
    expect(progress).toBeLessThan(result)
    expect(result).toBeLessThan(handoff)
    expect(src).toContain('language.t("session.task.return")')
    expect(src).toContain('language.t("session.task.archived"')
    expect(src).toContain("when={text()}")
    expect(src).not.toContain("when={task().result}")
    expect(src).toContain("item.stopped_child_count")
    expect(src).toContain("item.result.status")
    expect(src).toContain("item.target_session_id")
    expect(src).toContain("item.error")
    expect(src).not.toContain("watch(sdk.event.on")
    expect(src).toContain("language.intl()")
    expect(src).toContain('aria-live="polite"')
    expect(src).toContain('role="alert"')
    expect(src).not.toContain("resume")
  })

  test("replaces the runs entry without deleting its compatibility component", async () => {
    const page = await Bun.file(new URL("../session.tsx", import.meta.url)).text()

    expect(page).toContain('sessionView: "timeline" as "timeline" | "logs" | "task"')
    expect(page).toContain('language.t("session.tab.task")')
    expect(page).toContain("<SessionTask")
    expect(page).not.toContain('from "@/pages/session/session-runs"')
    expect(await Bun.file(new URL("session-runs.tsx", import.meta.url)).exists()).toBe(true)
  })

  test("wires current task summaries to the page lifecycle", async () => {
    const page = await Bun.file(new URL("../session.tsx", import.meta.url)).text()
    const component = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()
    expect(page).toContain("const monitor = observe")
    expect(page).toContain("monitor.change(id)")
    expect(page).toContain("onCleanup(monitor.stop)")
    expect(page).toContain("choose(params.id, latest()?.ready ? latest() : undefined, info()?.task)")
    expect(page.indexOf("const monitor = observe")).toBeLessThan(page.indexOf("const taskMode ="))
    expect(page).not.toContain("onSummary=")
    expect(component).not.toContain("watch(sdk.event.on")
    expect(component).not.toContain("refresh(() =>")
  })
})
