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
          type: "research",
          guards: [{ type: "permission", permission: "read", pattern: "*" }],
          outputs: { done: true },
          next: "write",
        },
        {
          id: "write",
          type: "implementation",
          mutates: true,
          verification: {
            required: true,
            must_pass: ["test"],
            commands: ["bun test"],
            artifacts: ["test-report"],
          },
        },
        {
          id: "test",
          type: "test",
          outputs: { passed: true },
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test("accepts a valid nodes DAG workflow", () => {
    const result = Workflow.Definition.safeParse({
      id: "dag",
      name: "Dag",
      nodes: [
        {
          id: "plan",
          type: "planning",
          outputs: { plan: true },
        },
        {
          id: "build",
          type: "implementation",
          mutates: true,
          depends_on: ["plan"],
          verification: {
            required: true,
            must_pass: ["test"],
          },
        },
        {
          id: "test",
          type: "test",
          depends_on: ["build"],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test("defaults workflow node agent to auto and accepts capability tags", () => {
    const result = Workflow.Definition.parse({
      id: "capable",
      name: "Capable",
      nodes: [{ id: "review", type: "review", capabilities: ["frontend", "typescript"] }],
    })

    expect(result.nodes[0].agent).toBe("auto")
    expect(result.nodes[0].capabilities).toEqual(["frontend", "typescript"])
  })

  test("accepts a loop node with child step session policies", () => {
    const result = Workflow.Definition.safeParse({
      id: "loop",
      name: "Loop",
      nodes: [
        {
          id: "build",
          type: "implementation",
          outputs: { built: true },
        },
        {
          id: "feedback",
          type: "loop",
          depends_on: ["build"],
          loop: {
            max_attempts: 3,
            until: [{ type: "variable", name: "passed", equals: true }],
            memory: {
              include: ["node.goal", "attempts.summary", "steps.test.output", "artifacts.diff"],
              summarize: { when: "context_tokens > 24000" },
            },
            steps: [
              {
                id: "test",
                type: "test",
                session: "per_call",
                outputs: { passed: "$ok" },
              },
              {
                id: "fix",
                type: "debug",
                session: "per_loop",
                mutates: true,
                outputs: { fixed: true },
              },
            ],
          },
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

  test("validates verification targets", () => {
    expect(
      Workflow.Definition.safeParse({
        id: "missing-verification",
        name: "Missing Verification",
        steps: [
          {
            id: "build",
            type: "implementation",
            verification: {
              required: true,
              must_pass: ["test"],
            },
          },
        ],
      }).success,
    ).toBe(false)

    expect(
      Workflow.Definition.safeParse({
        id: "wrong-target",
        name: "Wrong Target",
        steps: [
          {
            id: "build",
            type: "implementation",
            verification: {
              required: true,
              must_pass: ["docs"],
            },
          },
          {
            id: "docs",
            type: "documentation",
          },
        ],
      }).success,
    ).toBe(false)

    expect(
      Workflow.Definition.safeParse({
        id: "unjustified",
        name: "Unjustified",
        steps: [
          {
            id: "build",
            type: "implementation",
            verification: {
              required: true,
            },
          },
        ],
      }).success,
    ).toBe(false)

    expect(
      Workflow.Definition.safeParse({
        id: "justified",
        name: "Justified",
        steps: [
          {
            id: "build",
            type: "implementation",
            verification: {
              required: true,
              justification: "Documentation-only change.",
            },
          },
        ],
      }).success,
    ).toBe(true)
  })
})
