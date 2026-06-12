import { describe, expect, test } from "bun:test"
import { ActionResult } from "../../src/session/action-result"

describe("ActionResult", () => {
  test("accepts concise string fields for worker and verifier results", () => {
    expect(
      ActionResult.parse({
        kind: "action_result",
        role: "worker",
        action_id: "impl",
        status: "success",
        result: "# Full task result\n\nImplemented the task with evidence.",
        changed_files: "packages/api.ts",
        verification: "bun test",
        blockers: "none",
      }).success,
    ).toBe(true)

    expect(
      ActionResult.parse({
        kind: "action_result",
        role: "verifier",
        action_id: "impl_review",
        target_action_id: "impl",
        verification_role: "review",
        status: "pass",
        result: "Full review report with findings and evidence.",
        issues: "none",
        evidence: "Reviewed diff and test output.",
        worker_feedback: "Accepted.",
      }).success,
    ).toBe(true)
  })

  test("maps legacy summary input into result", () => {
    const parsed = ActionResult.parse({
      kind: "action_result",
      role: "worker",
      action_id: "impl",
      status: "success",
      summary: "Legacy summary-only result.",
      changed_files: "none",
      verification: "not run",
      blockers: "none",
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.result : "").toBe("Legacy summary-only result.")
  })
})
