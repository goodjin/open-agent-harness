import { describe, expect, test } from "bun:test"
import type { SessionRunResponse, SessionRunsResponse } from "@open-agent-harness/sdk/v2/client"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { groups, outcome, progress, task, view } from "./session-runs-data"

describe("session runs", () => {
  test("uses the planner prompt as task content", () => {
    expect(task({ input: { prompt: "Design the API" } } as never)).toBe("Design the API")
    expect(task({ input: { task: "Review the tests" } } as never)).toBe("Review the tests")
  })

  test("shows structured input when no task text exists", () => {
    expect(task({ input: { scope: "backend", risk: "high" } } as never)).toBe(
      '{\n  "scope": "backend",\n  "risk": "high"\n}',
    )
    expect(task({} as never)).toBeUndefined()
  })

  test("counts completed actions and groups documents by planning type", () => {
    expect(progress([{ status: "completed" }, { status: "failed" }, { status: "completed" }] as never)).toEqual({
      done: 2,
      total: 3,
    })
    expect(
      groups([
        { type: "plans", path: "plans/app.md" },
        { type: "requirements", path: "requirements/app.md" },
        { type: "manifest", path: "manifest.md" },
      ] as never).map((item) => item.type),
    ).toEqual(["requirements", "plans", "manifest"])
  })

  test("classifies run result availability", () => {
    expect(outcome({ status: "running" } as never)).toBe("running")
    expect(outcome({ status: "completed", summary: "Done", summary_source: "protocol" } as never)).toBe(
      "recorded",
    )
    expect(outcome({ status: "failed", summary: "Recovered", summary_source: "fallback_summary" } as never)).toBe(
      "fallback",
    )
    expect(outcome({ status: "blocked" } as never)).toBe("missing")
  })

  test("keeps generated list and detail fallback required", () => {
    const required = (_run: { fallback: boolean }) => true
    expect(required({} as SessionRunsResponse[number])).toBe(true)
    expect(required({} as SessionRunResponse)).toBe(true)
  })

  test("renders runtime and outcome badges as separate semantics", () => {
    const cases = [
      {
        run: { status: "completed" },
        status: "Completed",
        result: "Final result not recorded",
      },
      {
        run: { status: "failed", summary: "Recovered", summary_source: "fallback_summary" },
        status: "Failed",
        result: "Fallback",
      },
      {
        run: { status: "blocked", summary: "Waiting", summary_source: "action_result" },
        status: "Blocked",
        result: "Recorded",
      },
    ] as const

    cases.forEach((entry) => {
      const item = view({ run_id: "run", time: { started: 1 }, actions: [], documents: [], ...entry.run } as never)
      expect(en[item.status.label]).toBe(entry.status)
      expect(item.result && en[item.result.label]).toBe(entry.result)
    })

    const running = view({
      run_id: "run_running",
      status: "running",
      time: { started: 1 },
      actions: [],
      documents: [],
    } as never)
    expect(en[running.status.label]).toBe("Running")
    expect(running.result).toBeUndefined()
  })

  test("keeps compact list metadata for each task", () => {
    const item = view({
      run_id: "run_backend",
      status: "completed",
      time: { started: 100, completed: 200 },
      actions: [{ status: "completed" }, { status: "failed" }],
      documents: [{ path: "plans/app.md" }, { path: "reviews/app.md" }],
    } as never)
    expect(item.meta).toEqual({
      id: "run_backend",
      started: 100,
      completed: 200,
      progress: { done: 1, total: 2 },
      documents: 2,
    })
  })

  test("labels task ids and document counts in both languages", () => {
    expect(en["session.runs.runID"]).toBe("Run ID {{id}}")
    expect(en["session.runs.documentCount"]).toBe("{{count}} docs")
    expect(zh["session.runs.runID"]).toBe("运行 ID {{id}}")
    expect(zh["session.runs.documentCount"]).toBe("{{count}} 份文档")
  })
})
