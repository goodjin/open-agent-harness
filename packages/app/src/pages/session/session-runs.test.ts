import { describe, expect, test } from "bun:test"
import { groups, progress, task } from "./session-runs-data"

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
})
