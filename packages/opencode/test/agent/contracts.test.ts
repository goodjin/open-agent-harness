import { describe, expect, test } from "bun:test"
import { validateInput, validateOutput } from "../../src/agent/contracts"

const meta = {
  contracts: {
    input: [
      {
        name: "brief",
        required: true,
        sources: ["user"],
        content_types: ["text/markdown"],
        visibility: "model",
      },
    ],
  },
}

describe("validateInput", () => {
  test("blocks when required input is missing", () => {
    const got = validateInput({
      meta,
      inputs: [],
      artifacts: [],
      visibility: "model",
    })

    expect(got.status).toBe("block")
    expect(got.missing_inputs).toEqual(["brief"])
    expect(got.reasons).toEqual([
      {
        input: "brief",
        code: "missing_input",
        message: "Required input is missing",
      },
    ])
  })

  test("blocks wrong artifact type", () => {
    const got = validateInput({
      meta: {
        contracts: {
          input: [
            {
              name: "spec",
              required: true,
              artifact_types: ["prd"],
            },
          ],
        },
      },
      inputs: [],
      artifacts: [
        {
          name: "spec",
          source: "artifact",
          artifact_type: "notes",
          visibility: "model",
        },
      ],
      visibility: "model",
    })

    expect(got.status).toBe("block")
    expect(got.missing_inputs).toEqual([])
    expect(got.reasons).toEqual([
      {
        input: "spec",
        code: "artifact_type_mismatch",
        message: "Input artifact type is not allowed",
        expected: ["prd"],
        actual: "notes",
      },
    ])
  })

  test("waits for user when model visibility is denied", () => {
    const got = validateInput({
      meta,
      inputs: [
        {
          name: "brief",
          source: "user",
          content_type: "text/markdown",
          visibility: "private",
        },
      ],
      artifacts: [],
      visibility: "model",
    })

    expect(got.status).toBe("waiting_user")
    expect(got.missing_inputs).toEqual([])
    expect(got.reasons).toEqual([
      {
        input: "brief",
        code: "visibility_denied",
        message: "Input visibility does not allow model access",
        expected: "model",
        actual: "private",
      },
    ])
  })

  test("returns prerequisite decision when a matching edge can provide missing input", () => {
    const got = validateInput({
      meta: {
        contracts: {
          input: [
            {
              name: "research",
              required: true,
            },
          ],
        },
        collaboration: {
          edges: [
            {
              target: "researcher",
              mode: "prerequisite",
              provides: ["research"],
            },
          ],
        },
      },
      inputs: [],
      artifacts: [],
      visibility: "model",
    })

    expect(got.status).toBe("prerequisite")
    expect(got.missing_inputs).toEqual(["research"])
    expect(got.prerequisite).toEqual({
      target: "researcher",
      inputs: ["research"],
      edge: {
        target: "researcher",
        mode: "prerequisite",
        provides: ["research"],
      },
    })
  })

  test("returns ready for valid input", () => {
    const got = validateInput({
      meta,
      inputs: [
        {
          name: "brief",
          source: "user",
          content_type: "text/markdown",
          visibility: "model",
        },
      ],
      artifacts: [],
      visibility: "model",
    })

    expect(got.status).toBe("ready")
    expect(got.missing_inputs).toEqual([])
    expect(got.reasons).toEqual([])
  })
})

describe("validateOutput", () => {
  test("returns valid for available required output", () => {
    const got = validateOutput({
      contracts: {
        output: [
          {
            name: "report",
            required: true,
            artifact_type: "verification_report",
            content_type: "text/markdown",
            required_evidence: ["test"],
          },
        ],
      },
      artifacts: [
        {
          name: "report",
          type: "verification_report",
          content_type: "text/markdown",
          status: "available",
          evidence: [{ kind: "test", title: "contract test" }],
          source: "agent",
          visibility: "model",
        },
      ],
    })

    expect(got).toEqual({
      status: "valid",
      missing_artifacts: [],
      missing_evidence: [],
      reasons: [],
    })
  })

  test("returns partial when required output is missing", () => {
    const got = validateOutput({
      meta: {
        contracts: {
          output: [
            {
              name: "handoff",
              required: true,
              artifact_type: "document",
              content_type: "text/markdown",
            },
          ],
        },
      },
      artifacts: [
        {
          name: "handoff",
          type: "document",
          content_type: "text/markdown",
          status: "missing",
          evidence: [],
          source: "agent",
          visibility: "model",
          required: true,
        },
      ],
    })

    expect(got).toEqual({
      status: "partial",
      missing_artifacts: ["handoff"],
      missing_evidence: [],
      reasons: [
        {
          artifact: "handoff",
          code: "missing_artifact",
          message: "Required output artifact is missing",
        },
      ],
    })
  })

  test("returns invalid for wrong type and content type", () => {
    const got = validateOutput({
      contracts: {
        output: [
          {
            id: "summary",
            required: true,
            type: "document",
            content_type: "text/markdown",
          },
        ],
      },
      artifacts: [
        {
          name: "summary",
          type: "patch",
          content_type: "text/plain",
          status: "available",
          evidence: [],
          source: "agent",
          visibility: "model",
        },
      ],
    })

    expect(got).toEqual({
      status: "invalid",
      missing_artifacts: [],
      missing_evidence: [],
      reasons: [
        {
          artifact: "summary",
          code: "artifact_type_mismatch",
          message: "Output artifact type is not allowed",
          expected: "document",
          actual: "patch",
        },
        {
          artifact: "summary",
          code: "content_type_mismatch",
          message: "Output content type is not allowed",
          expected: "text/markdown",
          actual: "text/plain",
        },
      ],
    })
  })

  test("returns partial when required evidence is missing", () => {
    const got = validateOutput({
      meta: {
        completion: {
          required_evidence: ["test output"],
        },
        contracts: {
          output: [
            {
              name: "report",
              required: true,
              artifact_type: "verification_report",
            },
          ],
        },
      },
      artifacts: [
        {
          name: "report",
          type: "verification_report",
          content_type: "text/markdown",
          status: "available",
          evidence: [{ kind: "tool", title: "write file" }],
          source: "agent",
          visibility: "model",
        },
      ],
    })

    expect(got).toEqual({
      status: "partial",
      missing_artifacts: [],
      missing_evidence: ["report:test output"],
      reasons: [
        {
          artifact: "report",
          code: "missing_evidence",
          message: "Required output evidence is missing",
          expected: "test output",
        },
      ],
    })
  })

  test("returns invalid for invalid artifact record", () => {
    const got = validateOutput({
      artifacts: [
        {
          name: "",
          type: "",
          content_type: "text/plain",
          status: "invalid",
          evidence: [{ kind: "normalizer", title: "Artifact is missing name or type" }],
          source: "agent",
          visibility: "model",
        },
      ],
    })

    expect(got).toEqual({
      status: "invalid",
      missing_artifacts: [],
      missing_evidence: [],
      reasons: [
        {
          artifact: "",
          code: "invalid_artifact",
          message: "Artifact record is invalid",
        },
      ],
    })
  })
})
