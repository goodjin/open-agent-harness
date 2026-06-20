import { describe, expect, test } from "bun:test"
import { AgentProtocol } from "../../src/protocol/schema"

function parse(input: object) {
  const decl = AgentProtocol.parse(input)
  if (decl.payload?.type !== "action_graph") throw new Error("expected action_graph")
  return decl.payload.actions
}

describe("AgentProtocol schema strips the 'none' depends_on sentinel", () => {
  test("V2 input with depends: ['none'] is parsed as empty depends_on", () => {
    const decl = AgentProtocol.parse({
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Test",
      payload: {
        type: "action_graph",
        actions: [
          {
            id: "review",
            type: "action",
            title: "Review",
            operation: "review",
            executor: { type: "agent", target: "security-reviewer", capabilities: [] },
            depends_on: ["none"],
            context_refs: [],
            result_policy: "summary",
          },
        ],
      },
    })
    if (decl.payload?.type !== "action_graph") throw new Error("not action_graph")
    expect(decl.payload.actions[0]?.depends_on).toEqual([])
  })

  test("V2 protocol 'none' mixed with real deps is filtered out", () => {
    const decl = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "a", kind: "agent", target: "backend", prompt: "do", depends: [] },
        { id: "b", kind: "agent", target: "frontend", prompt: "do", depends: [] },
        { id: "v", kind: "agent", target: "verifier", prompt: "verify", depends: ["a", "none", "b"] },
      ],
    })
    if (decl.payload?.type !== "action_graph") throw new Error("not action_graph")
    const verify = decl.payload.actions.find((a) => a.id === "v")
    expect(verify?.depends_on).toEqual(["a", "b"])
  })

  test("V1 canonical 'none' is filtered out of depends_on", () => {
    const decl = AgentProtocol.parse({
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Test",
      payload: {
        type: "action_graph",
        actions: [
          {
            id: "review",
            type: "action",
            title: "Review",
            operation: "review",
            executor: { type: "agent", target: "security-reviewer", capabilities: [] },
            depends_on: ["none"],
            context_refs: [],
            result_policy: "summary",
          },
        ],
      },
    })
    if (decl.payload?.type !== "action_graph") throw new Error("not action_graph")
    expect(decl.payload.actions[0]?.depends_on).toEqual([])
  })

  test("NONE_DEPENDENCY constant equals 'none'", () => {
    expect(AgentProtocol.NONE_DEPENDENCY).toBe("none")
  })
})

describe("verifier depends_on parsing (action-level contract)", () => {
  test("preserves empty depends_on for verifier items", () => {
    const actions = parse({
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Test",
      payload: {
        type: "action_graph",
        actions: [
          {
            id: "verify_1",
            type: "action",
            title: "Verify backend",
            operation: "verify",
            executor: { type: "agent", target: "backend-verifier", capabilities: [] },
            depends_on: [],
            context_refs: [],
            result_policy: "summary",
          },
        ],
      },
    })
    expect(actions.find((item) => item.id === "verify_1")?.depends_on).toEqual([])
  })

  test("preserves verifier dependency on a different agent target", () => {
    const actions = parse({
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Test",
      payload: {
        type: "action_graph",
        actions: [
          {
            id: "impl_1",
            type: "action",
            title: "Frontend",
            operation: "do",
            executor: { type: "agent", target: "frontend", capabilities: [] },
            depends_on: [],
            context_refs: [],
            result_policy: "summary",
          },
          {
            id: "verify_1",
            type: "action",
            title: "Verify backend",
            operation: "verify",
            executor: { type: "agent", target: "backend-verifier", capabilities: [] },
            depends_on: ["impl_1"],
            context_refs: [],
            result_policy: "summary",
          },
        ],
      },
    })
    expect(actions.find((item) => item.id === "verify_1")?.depends_on).toEqual(["impl_1"])
  })

  test("preserves dependencies when multiple workers use the same agent target", () => {
    const actions = parse({
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Test",
      payload: {
        type: "action_graph",
        actions: [
          {
            id: "complete_m4_e4_files",
            type: "action",
            title: "Complete M4",
            operation: "do",
            executor: { type: "agent", target: "general-executor", capabilities: [] },
            depends_on: [],
            context_refs: [],
            result_policy: "summary",
          },
          {
            id: "verify_m4_e4_completion",
            type: "action",
            title: "Verify M4",
            operation: "review",
            executor: { type: "agent", target: "general-executor-verifier", capabilities: [] },
            depends_on: ["complete_m4_e4_files"],
            context_refs: [],
            result_policy: "summary",
          },
          {
            id: "finalize_m2_pipeline_doc",
            type: "action",
            title: "Finalize M2",
            operation: "do",
            executor: { type: "agent", target: "general-executor", capabilities: [] },
            depends_on: [],
            context_refs: [],
            result_policy: "summary",
          },
        ],
      },
    })
    expect(actions.find((item) => item.id === "verify_m4_e4_completion")?.depends_on).toEqual(["complete_m4_e4_files"])
  })
})
