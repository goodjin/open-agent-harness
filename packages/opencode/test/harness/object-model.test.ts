import { describe, expect, test } from "bun:test"
import { Harness } from "../../src/harness/schema"

const producer = {
  type: "runtime",
  id: "runtime.core",
}

describe("harness v2 object model", () => {
  test("accepts the six core object categories", () => {
    expect(Harness.ObjectCategory.options).toEqual(["fact", "view", "evidence", "resource", "context", "policy"])
  })

  test("requires stable metadata on v2 objects", () => {
    const obj = Harness.Object.parse({
      id: "fact_run_goal_01",
      schema_version: "v2.0",
      category: "fact",
      kind: "run_goal",
      producer,
      visibility: "project",
      lifecycle: "active",
      created_at: 1,
      updated_at: 2,
      refs: ["resource://res_01"],
      summary: "User goal accepted by runtime.",
      data: { goal: "ship resource first harness" },
    })

    expect(obj.schema_version).toBe("v2.0")
    expect(obj.producer.type).toBe("runtime")
    expect(obj.visibility).toBe("project")
    expect(obj.lifecycle).toBe("active")
    expect(obj.refs).toEqual(["resource://res_01"])
  })

  test("rejects v2 objects with unknown metadata fields", () => {
    expect(() =>
      Harness.Object.parse({
        id: "fact_run_goal_01",
        schema_version: "v2.0",
        category: "fact",
        kind: "run_goal",
        producer,
        visibility: "project",
        lifecycle: "active",
        created_at: 1,
        updated_at: 2,
        extra: true,
      }),
    ).toThrow()
  })

  test("accepts every M0 reference protocol target", () => {
    const refs = [
      "resource://res_01",
      "document://doc_01",
      "artifact://art_01",
      "action://act_01",
      "handoff://handoff_01",
      "trace://trace_01",
      "projection://run/run_01/current",
      "memory://mem_01",
      "snapshot://snap_01",
    ]

    expect(refs.map((ref) => Harness.Ref.parse(ref))).toEqual(refs)
  })

  test("rejects unsupported refs", () => {
    expect(() => Harness.Ref.parse("session://msg_01")).toThrow()
    expect(() => Harness.Ref.parse("resource://")).toThrow()
    expect(() => Harness.Ref.parse("resource:res_01")).toThrow()
  })

  test("validates resource context memory workflow and policy objects", () => {
    const base = {
      schema_version: "v2.0",
      producer,
      visibility: "project",
      lifecycle: "active",
      created_at: 1,
      updated_at: 1,
    }

    const res = Harness.ResourceObject.parse({
      ...base,
      id: "res_01",
      category: "resource",
      kind: "document",
      uri: "file://docs/report.md",
      media_type: "text/markdown",
      summary: "Report resource",
      evidence: ["trace://trace_01"],
    })
    const ctx = Harness.ContextObject.parse({
      ...base,
      id: "ctx_01",
      category: "context",
      kind: "bundle",
      target: "agent.worker",
      included: ["resource://res_01"],
      excluded: [{ ref: "memory://mem_01", reason: "outside visibility" }],
      budget: { tokens: 4000 },
    })
    const mem = Harness.MemoryObject.parse({
      ...base,
      id: "mem_01",
      category: "fact",
      kind: "project_memory",
      scope: "project",
      namespace: "harness",
      status: "current",
      evidence: ["resource://res_01"],
    })
    const flow = Harness.WorkflowObject.parse({
      ...base,
      id: "flow_01",
      category: "policy",
      kind: "workflow_profile",
      version: 1,
      nodes: ["action://act_01"],
      criteria: ["tests pass"],
    })
    const pol = Harness.PolicyObject.parse({
      ...base,
      id: "policy_01",
      category: "policy",
      kind: "acceptance_policy",
      rules: [{ when: "risk:high", then: "human" }],
    })

    expect(res.evidence).toEqual(["trace://trace_01"])
    expect(ctx.excluded[0]?.reason).toBe("outside visibility")
    expect(mem.scope).toBe("project")
    expect(flow.nodes).toEqual(["action://act_01"])
    expect(pol.rules[0]?.then).toBe("human")
  })

  test("maps v1 semantics to v2 object contracts", () => {
    const map = Harness.V1Mapping.parse({
      artifact: ["resource", "evidence"],
      context: ["context", "view"],
      memory: ["fact"],
      workflow: ["policy", "view"],
    })

    expect(map.artifact).toEqual(["resource", "evidence"])
    expect(map.context).toEqual(["context", "view"])
    expect(map.memory).toEqual(["fact"])
    expect(map.workflow).toEqual(["policy", "view"])
  })
})
