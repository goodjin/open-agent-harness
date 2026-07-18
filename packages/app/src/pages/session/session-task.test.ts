import { describe, expect, test } from "bun:test"
import type { SessionTaskCurrentResponse, SessionTaskRevisionResponse } from "@open-agent-harness/sdk/v2/client"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { action, content, handoff, initial, progress, refresh, requests, stamp, view, watch } from "./session-task-data"

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

  test("loads current eagerly and history details only from explicit actions", async () => {
    const src = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()

    expect(src).toContain("sdk.client.session.task.current")
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
    expect(src).toContain("const bind = watch(sdk.event.on")
    expect(src).toContain("bind(id)")
    expect(src).toContain("bind()")
    expect(src).toContain("language.intl()")
    expect(src).toContain('aria-live="polite"')
    expect(src).toContain('role="alert"')
    expect(src).not.toContain("resume")
  })

  test("replaces the runs entry without deleting its compatibility component", async () => {
    const page = await Bun.file(new URL("../session.tsx", import.meta.url)).text()

    expect(page).toContain('sessionView: "timeline" as "timeline" | "logs" | "task"')
    expect(page).toContain('language.t("session.tab.task")')
    expect(page).toContain("<SessionTask sessionID={id} />")
    expect(page).not.toContain('from "@/pages/session/session-runs"')
    expect(await Bun.file(new URL("session-runs.tsx", import.meta.url)).exists()).toBe(true)
  })
})
