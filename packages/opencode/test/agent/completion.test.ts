import { describe, expect, test } from "bun:test"
import { evaluateCompletion } from "../../src/agent/completion"

describe("evaluateCompletion", () => {
  test("treats done as partial when a required artifact is missing", () => {
    const got = evaluateCompletion({
      meta: {
        completion: {
          required_artifacts: ["handoff"],
        },
      },
      signals: {
        done: true,
      },
      artifacts: [],
    })

    expect(got.status).toBe("partial")
    expect(got.missing_artifacts).toEqual(["handoff"])
    expect(got.reasons).toEqual([
      {
        code: "missing_artifact",
        message: "Required artifact is missing",
        target: "handoff",
      },
    ])
    expect(got.next).toBe("produce_missing_artifacts")
  })

  test("requires evidence even when patch artifact exists", () => {
    const got = evaluateCompletion({
      meta: {
        completion: {
          required_artifacts: ["patch"],
          required_evidence: ["test_report"],
        },
      },
      artifacts: [
        {
          name: "patch",
          status: "available",
        },
      ],
      evidence: [],
    })

    expect(got.status).toBe("partial")
    expect(got.missing_artifacts).toEqual([])
    expect(got.missing_evidence).toEqual(["test_report"])
    expect(got.next).toBe("collect_missing_evidence")
  })

  test("waits for user when a required human gate is pending", () => {
    const got = evaluateCompletion({
      meta: {
        completion: {
          gates: [
            {
              id: "approval",
              type: "human",
              required: true,
            },
          ],
        },
      },
      gates: [
        {
          id: "approval",
          type: "human",
          status: "pending",
        },
      ],
    })

    expect(got.status).toBe("waiting_user")
    expect(got.failed_gates).toEqual(["approval"])
    expect(got.next).toBe("wait_for_user")
  })

  test("blocks when a required dependency failed", () => {
    const got = evaluateCompletion({
      dependencies: [
        {
          id: "verification",
          required: true,
          status: "failed",
        },
      ],
    })

    expect(got.status).toBe("blocked")
    expect(got.reasons).toEqual([
      {
        code: "failed_dependency",
        message: "Required dependency failed",
        target: "verification",
      },
    ])
    expect(got.next).toBe("resolve_dependencies")
  })

  test("completes when all criteria are satisfied", () => {
    const got = evaluateCompletion({
      meta: {
        completion: {
          required_artifacts: ["patch"],
          required_evidence: ["test_report"],
          gates: [
            {
              id: "ci",
              required: true,
            },
          ],
        },
      },
      signals: {
        done: true,
      },
      dependencies: [
        {
          id: "research",
          required: true,
          status: "completed",
        },
      ],
      artifacts: [
        {
          name: "patch",
          status: "available",
        },
      ],
      evidence: [
        {
          name: "test_report",
          status: "available",
        },
      ],
      gates: [
        {
          id: "ci",
          status: "passed",
        },
      ],
      validation: {
        status: "passed",
      },
    })

    expect(got).toEqual({
      status: "completed",
      reasons: [],
      missing_artifacts: [],
      missing_evidence: [],
      failed_gates: [],
      unresolved: [],
      next: "complete",
    })
  })
})
