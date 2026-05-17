import { describe, expect, test } from "bun:test"
import { Workflow } from "../../src/workflow/schema"

describe("workflow schema", () => {
  test("accepts a valid workflow", () => {
    const result = Workflow.Definition.safeParse({
      id: "valid",
      name: "Valid",
      inputs: {
        topic: { type: "string", required: true },
      },
      outputs: {
        summary: { from: "write.summary" },
      },
      error_policy: {
        strategy: "retry",
        max_attempts: 2,
      },
      steps: [
        {
          id: "read",
          guards: [{ type: "permission", permission: "read", pattern: "*" }],
          outputs: { done: true },
          next: "write",
        },
        {
          id: "write",
          mutates: true,
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test("rejects invalid and duplicate workflows", () => {
    expect(
      Workflow.Definition.safeParse({
        id: "missing",
        name: "Missing",
        steps: [],
      }).success,
    ).toBe(false)

    expect(
      Workflow.Definition.safeParse({
        id: "duplicate",
        name: "Duplicate",
        steps: [{ id: "same" }, { id: "same" }],
      }).success,
    ).toBe(false)
  })
})
