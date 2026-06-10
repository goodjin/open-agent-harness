import { describe, expect, test } from "bun:test"
import { revive } from "../../src/project/bootstrap"

describe("project bootstrap session restore policy", () => {
  test("automatically continues queued rate limited and retry sessions", () => {
    expect(revive({ type: "queued" }, false)).toBe(true)
    expect(
      revive(
        {
          type: "rate_limited",
          providerID: "p",
          modelID: "m",
          scope: "model",
          active: 1,
          limit: 1,
          queued: 1,
        },
        false,
      ),
    ).toBe(true)
    expect(revive({ type: "retry", attempt: 1, message: "retry", next: Date.now() }, false)).toBe(true)
  })

  test("continues interrupted running or starting sessions only when no stale tool was found", () => {
    expect(revive({ type: "interrupted", prior: "running" }, false)).toBe(true)
    expect(revive({ type: "interrupted", prior: "starting" }, false)).toBe(true)
    expect(revive({ type: "interrupted", prior: "running" }, true)).toBe(false)
    expect(revive({ type: "interrupted", prior: "starting" }, true)).toBe(false)
  })

  test("does not continue terminal or user-waiting sessions", () => {
    expect(revive({ type: "completed" }, false)).toBe(false)
    expect(revive({ type: "waiting_user" }, false)).toBe(false)
    expect(revive({ type: "waiting_permission" }, false)).toBe(false)
    expect(revive({ type: "failed", message: "failed" }, false)).toBe(false)
  })
})
