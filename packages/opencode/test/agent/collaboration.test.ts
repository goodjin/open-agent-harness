import { describe, expect, test } from "bun:test"
import { AgentCollaboration } from "../../src/agent/collaboration"

const ctx = {
  meta: {
    id: "builder",
    collaboration: {
      edges: [
        {
          kind: "prerequisite",
          trigger: "missing_input",
          target: "researcher",
          required: true,
          dedupe_key: "research",
          depends: ["inspect"],
          input: { need: "research" },
        },
        {
          kind: "verifier",
          trigger: ["complete", "submitted"],
          target: "tester",
          failure_policy: "block",
        },
        {
          kind: "recovery",
          trigger: { status: "failed" },
          target: "debugger",
          failure_policy: "retry",
        },
        {
          kind: "arbiter",
          trigger: { event: "conflict" },
          target: "lead",
          failure_policy: "escalate",
        },
        {
          kind: "fallback",
          trigger: "unavailable",
          target: "generalist",
          failure_policy: "continue",
        },
      ],
    },
  },
  source: {
    agent: "builder",
    action: "implement",
    depth: 1,
  },
  projection: {
    missing_inputs: ["research"],
  },
  trace: [
    {
      kind: "action",
      status: "completed",
      target: "builder",
    },
  ],
}

describe("AgentCollaboration", () => {
  test("matches prerequisite edges and expands an assignment plan", () => {
    const matched = AgentCollaboration.matchEdges({
      ...ctx,
      trigger: "missing_input",
    })

    expect(matched.edges.map((item) => item.kind)).toEqual(["prerequisite"])
    expect(AgentCollaboration.expandEdge(matched.edges[0], { ...ctx, trigger: "missing_input" })).toEqual({
      kind: "assignment",
      id: "builder-prerequisite-researcher-research",
      edge_kind: "prerequisite",
      target: "researcher",
      required: true,
      failure_policy: "block",
      dedupe_key: "research",
      depends: ["inspect"],
      trigger: "missing_input",
      input: { need: "research" },
      source: {
        agent: "builder",
        action: "implement",
        depth: 1,
      },
    })
  })

  test("expands verifier, recovery, arbiter, and fallback plans for matching triggers", () => {
    expect(AgentCollaboration.plan({ ...ctx, trigger: "complete" }).items).toEqual([
      {
        kind: "action",
        id: "builder-verifier-tester",
        edge_kind: "verifier",
        target: "tester",
        required: false,
        failure_policy: "block",
        dedupe_key: "builder:verifier:tester",
        depends: [],
        trigger: "complete",
        input: {},
        source: ctx.source,
      },
    ])

    expect(AgentCollaboration.plan({ ...ctx, trigger: { status: "failed" } }).items.map((item) => item.edge_kind)).toEqual(["recovery"])
    expect(AgentCollaboration.plan({ ...ctx, trigger: { event: "conflict" } }).items.map((item) => item.kind)).toEqual(["handoff"])
    expect(AgentCollaboration.plan({ ...ctx, trigger: "unavailable" }).items.map((item) => item.edge_kind)).toEqual(["fallback"])
  })

  test("accepts to as a metadata edge target alias", () => {
    expect(AgentCollaboration.plan({
      meta: {
        collaboration: {
          edges: [{ kind: "fallback", trigger: "no_specialist_match", to: "general" }],
        },
      },
      trigger: "no_specialist_match",
      source: { agent: "default" },
    }).items[0]?.target).toBe("general")
  })

  test("dedupes by explicit and derived keys", () => {
    const edges = AgentCollaboration.matchEdges({
      meta: {
        collaboration: {
          edges: [
            { kind: "peer", trigger: "review", target: "frontend", dedupe_key: "peer-review" },
            { kind: "peer", trigger: "review", target: "frontend", dedupe_key: "peer-review" },
            { kind: "reviewer", trigger: "review", target: "security" },
            { kind: "reviewer", trigger: "review", target: "security" },
          ],
        },
      },
      trigger: "review",
      source: { agent: "builder" },
    }).edges

    expect(AgentCollaboration.dedupe(edges).map((item) => item.target)).toEqual(["frontend", "security"])
  })

  test("checks max_depth and max_parallel limits", () => {
    const got = AgentCollaboration.plan({
      meta: {
        collaboration: {
          limits: { max_depth: 1, max_parallel: 1 },
          edges: [
            { kind: "monitor", trigger: "start", target: "observer" },
            { kind: "splitter", trigger: "start", target: "planner" },
          ],
        },
      },
      trigger: "start",
      source: { agent: "builder", depth: 1 },
    })

    expect(got.items.map((item) => item.target)).toEqual(["observer"])
    expect(got.diagnostics.map((item) => item.code)).toEqual(["max_parallel"])
    expect(
      AgentCollaboration.checkLimits({
        limits: { max_depth: 1 },
        source: { depth: 2 },
        count: 1,
      }),
    ).toEqual([
      {
        code: "max_depth",
        message: "Collaboration depth exceeds max_depth",
        edge: undefined,
        limit: 1,
      },
    ])
  })

  test("reports unsupported kind and trigger mismatch diagnostics", () => {
    const got = AgentCollaboration.matchEdges({
      meta: {
        collaboration: {
          edges: [
            { kind: "handoff", trigger: "complete", target: "assistant" },
            { kind: "reviewer", trigger: "review", target: "reviewer" },
          ],
        },
      },
      trigger: "complete",
      source: { agent: "builder" },
    })

    expect(got.edges).toEqual([])
    expect(got.diagnostics.map((item) => item.code)).toEqual(["unsupported_kind", "trigger_mismatch"])
  })
})
