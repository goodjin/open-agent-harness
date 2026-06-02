import { describe, expect, test } from "bun:test"
import { AgentArtifact } from "../../src/agent/artifact"

describe("agent artifact records", () => {
  test("creates expected records from optional output contracts", () => {
    const got = AgentArtifact.records({
      contracts: {
        output: [
          {
            name: "plan",
            artifact_type: "document",
            content_type: "text/markdown",
            source: "subagent",
            visibility: "model",
          },
        ],
      },
    })

    expect(got).toEqual([
      {
        name: "plan",
        type: "document",
        content_type: "text/markdown",
        status: "expected",
        evidence: [],
        source: "subagent",
        visibility: "model",
        required: false,
      },
    ])
  })

  test("extracts available records from explicit artifacts and result metadata", () => {
    const got = AgentArtifact.records({
      artifacts: [
        {
          name: "patch",
          type: "diff",
          content_type: "text/x-diff",
          content: "diff --git a/a b/a",
          source: "tool",
          visibility: "model",
        },
      ],
      results: [
        {
          metadata: {
            artifacts: [
              {
                name: "summary",
                artifact_type: "document",
                content_type: "text/markdown",
                content: "done",
                source: "subagent",
                visibility: "model",
              },
            ],
          },
        },
      ],
    })

    expect(got).toEqual([
      {
        name: "patch",
        type: "diff",
        content_type: "text/x-diff",
        status: "available",
        evidence: [],
        source: "tool",
        visibility: "model",
        content: "diff --git a/a b/a",
      },
      {
        name: "summary",
        type: "document",
        content_type: "text/markdown",
        status: "available",
        evidence: [],
        source: "subagent",
        visibility: "model",
        content: "done",
      },
    ])
  })

  test("marks required output contracts missing when no artifact is available", () => {
    const got = AgentArtifact.records({
      meta: {
        contracts: {
          output: [
            {
              id: "handoff",
              required: true,
              artifact_type: "document",
              content_type: "text/markdown",
            },
          ],
        },
      },
      artifacts: [],
    })

    expect(got).toEqual([
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
    ])
  })

  test("preserves evidence metadata on available records", () => {
    const got = AgentArtifact.records({
      results: [
        {
          metadata: {
            evidence: [
              {
                kind: "tool",
                id: "call_1",
                title: "write file",
              },
            ],
            artifact: {
              name: "notes",
              type: "text",
              content_type: "text/plain",
              content: "notes",
            },
          },
        },
      ],
    })

    expect(got[0]).toEqual({
      name: "notes",
      type: "text",
      content_type: "text/plain",
      status: "available",
      evidence: [
        {
          kind: "tool",
          id: "call_1",
          title: "write file",
        },
      ],
      source: "agent",
      visibility: "model",
      content: "notes",
    })
  })

  test("matches plain text result to a single expected output contract", () => {
    const got = AgentArtifact.records({
      meta: {
        contracts: {
          output: [
            {
              name: "report",
              required: true,
              artifact_type: "verification_report",
              content_type: "text/markdown",
            },
          ],
        },
      },
      results: [
        {
          content: "Checked the implementation.",
          source: "tester",
          metadata: {
            evidence: [
              {
                kind: "test",
                id: "test_agent",
              },
            ],
          },
        },
      ],
    })

    expect(got).toEqual([
      {
        name: "report",
        type: "verification_report",
        content_type: "text/markdown",
        status: "available",
        evidence: [
          {
            kind: "test",
            id: "test_agent",
          },
        ],
        source: "tester",
        visibility: "model",
        content: "Checked the implementation.",
        required: true,
      },
    ])
  })

  test("marks malformed artifacts invalid without validating output completion", () => {
    const got = AgentArtifact.records({
      artifacts: [
        {
          content_type: "text/plain",
          content: "missing name and type",
        },
      ],
    })

    expect(got).toEqual([
      {
        name: "",
        type: "",
        content_type: "text/plain",
        status: "invalid",
        evidence: [
          {
            kind: "normalizer",
            title: "Artifact is missing name or type",
          },
        ],
        source: "agent",
        visibility: "model",
        content: "missing name and type",
      },
    ])
  })
})
