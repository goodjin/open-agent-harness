import { describe, expect, test } from "bun:test"
import type { SessionTaskCurrentResponse } from "@open-agent-harness/sdk/v2/client"
import { initial, view } from "./session-task-data"

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
    expect(src).toContain("AbortController")
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
