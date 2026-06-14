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

  test("describes strict worker and verifier protocol", () => {
    const text = ActionResult.protocol({ action: "impl" }).join("\n")
    expect(text).toContain("The top-level JSON object must contain role.")
    expect(text).toContain("role selects the protocol branch")
    expect(text).toContain("Worker required fields: role, action_id, status, result.")
    expect(text).toContain('"role": "worker"')
    expect(text).toContain('"action_id": "impl"')

    const verifier = ActionResult.protocol({ verifier: true, action: "review", target: "impl" }).join("\n")
    expect(verifier).toContain("Verifier required fields: role, action_id, target_action_id, status, result.")
    expect(verifier).toContain('"role": "verifier"')
    expect(verifier).toContain('"target_action_id": "impl"')
  })
})
