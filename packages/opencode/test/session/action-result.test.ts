import { describe, expect, test } from "bun:test"
import { ActionResult } from "../../src/session/action-result"

describe("ActionResult", () => {
  test("accepts concise string fields for worker and verifier results", () => {
    expect(
      ActionResult.parse({
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
        action_id: "impl_review",
        target_action_id: "impl",
        status: "pass",
        result: "Full review report with findings and evidence.",
        issues: "none",
        evidence: "Reviewed diff and test output.",
        worker_feedback: "Accepted.",
      }).success,
    ).toBe(true)
  })

  test("ignores legacy and ambiguous input fields", () => {
    for (const extra of ["kind", "role", "result_type", "summary", "task_background", "task_content"]) {
      const parsed = ActionResult.parse({
        [extra]: extra === "summary" ? "Legacy summary." : "ignored",
        action_id: "impl",
        status: "success",
        result: "Task completed.",
      })
      expect(parsed.success).toBe(true)
      expect(parsed.success ? parsed.data.result : "").toBe("Task completed.")
      expect(parsed.success ? parsed.data.role : "").toBe("worker")
      expect(parsed.success && "result_type" in parsed.data).toBe(false)
      expect(parsed.success && "task_background" in parsed.data).toBe(false)
      expect(parsed.success && "task_content" in parsed.data).toBe(false)
    }
  })

  test("does not map legacy summary into result", () => {
    expect(
      ActionResult.parse({
        action_id: "impl",
        status: "success",
        summary: "Legacy summary.",
      }).success,
    ).toBe(false)
  })

  test("accepts internal stored result shape after tool execution", () => {
    const parsed = ActionResult.stored({
      kind: "action_result",
      role: "worker",
      action_id: "impl",
      status: "success",
      result: "Task completed.",
      changed_files: "none",
      verification: "bun test",
      blockers: "none",
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.role : "").toBe("worker")
  })

  test("can expose worker-only and verifier-only input schemas", () => {
    expect(
      ActionResult.worker({
        action_id: "impl",
        status: "success",
        result: "Task completed.",
      }).success,
    ).toBe(true)

    expect(
      ActionResult.worker({
        action_id: "impl_review",
        target_action_id: "impl",
        status: "pass",
        result: "Review passed.",
      }).success,
    ).toBe(false)

    expect(
      ActionResult.verifier({
        action_id: "impl_review",
        target_action_id: "impl",
        status: "pass",
        result: "Review passed.",
      }).success,
    ).toBe(true)

    expect(
      ActionResult.verifier({
        action_id: "impl",
        status: "success",
        result: "Task completed.",
      }).success,
    ).toBe(false)
  })

  test("describes strict worker and verifier protocol", () => {
    const text = ActionResult.protocol({ action: "impl" }).join("\n")
    expect(text).toContain("Worker result required fields: action_id, status, result.")
    expect(text).toContain("Worker status values: success, failure, error, reply.")
    expect(text).toContain("Worker optional fields: scope, changed_files, verification, blockers.")
    expect(text).toContain("Worker scope values: task, verification_feedback, final_summary.")
    expect(text).not.toContain('"result_type": "worker"')
    expect(text).not.toContain('"role": "worker"')
    expect(text).not.toContain("task_background")
    expect(text).toContain('"action_id": "impl"')

    const verifier = ActionResult.protocol({ verifier: true, action: "review", target: "impl" }).join("\n")
    expect(verifier).toContain("Verifier result required fields: action_id, target_action_id, status, result.")
    expect(verifier).toContain("Verifier status values: pass, fail, error, reply, skipped.")
    expect(verifier).toContain("Verifier optional fields: issues, evidence, worker_feedback.")
    expect(verifier).not.toContain('"result_type": "verifier"')
    expect(verifier).not.toContain('"role": "verifier"')
    expect(verifier).toContain('"target_action_id": "impl"')
  })
})
