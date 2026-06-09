import { describe, expect, test } from "bun:test"
import { AgentProtocolExecutor } from "../../src/protocol/executor"
import type { AgentProtocol } from "../../src/protocol/schema"

const decl: AgentProtocol.Declaration = {
  type: "agent.protocol",
  version: "1",
  intent: "execute",
  persist: false,
  title: "Inspect",
  execution: { strategy: "sequential" },
  payload: {
    type: "action_graph",
    actions: [
      {
        type: "action",
        id: "inspect",
        title: "Inspect",
        operation: "search",
        executor: { type: "tool", target: "grep", capabilities: [] },
        input: { pattern: "source" },
        depends_on: [],
        context_refs: [],
        prompt_ref: "md:inspect",
        result_policy: "summary",
      },
      {
        type: "action",
        id: "bad",
        title: "Unsafe",
        operation: "ask",
        executor: { type: "tool", target: "edit", capabilities: [] },
        input: { filePath: "test.ts", oldString: "a", newString: "b" },
        depends_on: ["inspect"],
        context_refs: [],
        result_policy: "summary",
      },
    ],
  },
}

describe("agent protocol executor", () => {
  test("executes sequential tool actions without changing tool availability", async () => {
    const result = await AgentProtocolExecutor.run({
      declaration: decl,
      sections: { inspect: "Find source files" },
      execute: async (action) => ({
        title: action.title,
        output: `ran ${action.id}`,
        metadata: { callID: `call_${action.id}` },
      }),
    })

    expect(result.type).toBe("agent.protocol.result")
    expect(result.status).toBe("completed")
    expect(result.actions.map((item) => [item.id, item.status])).toEqual([
      ["inspect", "completed"],
      ["bad", "completed"],
    ])
    expect(result.metrics.internal_tool_calls).toBe(2)
  })

  test("selects delegable agents by purpose and capability tags", async () => {
    const action: AgentProtocol.Action = {
      type: "action",
      id: "review",
      title: "Review",
      operation: "review_code",
      executor: { type: "agent", target: "auto", capabilities: ["typescript"] },
      depends_on: [],
      context_refs: [],
      result_policy: "summary",
    }

    expect(
      AgentProtocolExecutor.select(action, [
        { id: "hidden", entry: { hidden: true }, capability: { purpose: "review_code", tags: ["typescript"] } },
        { id: "generic", capability: { purpose: "inspect", tags: ["typescript"] } },
        { id: "reviewer", capability: { purpose: "review_code", tags: ["typescript"] } },
      ])?.id,
    ).toBe("reviewer")
  })

  test("selects delegable agents by requested capability purpose", async () => {
    const action: AgentProtocol.Action = {
      type: "action",
      id: "review",
      title: "Review",
      operation: "agent",
      executor: { type: "agent", target: "auto", capabilities: ["general"] },
      depends_on: [],
      context_refs: [],
      result_policy: "summary",
    }

    expect(
      AgentProtocolExecutor.select(action, [
        { id: "reviewer", capability: { purpose: "review_code", tags: [] } },
        { id: "general", capability: { purpose: "general", tags: [] } },
      ])?.id,
    ).toBe("general")
  })

  test("marks tool failures without blocking remaining actions", async () => {
    const result = await AgentProtocolExecutor.run({
      declaration: decl,
      sections: { inspect: "Find source files" },
      execute: async (action) => ({
        title: action.title,
        output: action.id === "inspect" ? "missing file" : `ran ${action.id}`,
        metadata: action.id === "inspect" ? { callID: `call_${action.id}`, failed: true } : { callID: `call_${action.id}` },
      }),
    })

    expect(result.status).toBe("failed")
    expect(result.actions.map((item) => [item.id, item.status])).toEqual([
      ["inspect", "failed"],
      ["bad", "completed"],
    ])
    expect(result.actions[0]?.error).toBe("missing file")
    expect(result.metrics.internal_tool_calls).toBe(2)
  })

  test("marks skipped actions without failing the run", async () => {
    const result = await AgentProtocolExecutor.run({
      declaration: {
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        persist: false,
        title: "Verify",
        execution: { strategy: "sequential" },
        payload: {
          type: "action_graph",
          actions: [
            {
              type: "action",
              id: "test_patch",
              title: "Test patch",
              operation: "verification_test",
              executor: { type: "agent", target: "backend-verifier", capabilities: ["test"] },
              depends_on: ["backend_patch"],
              context_refs: [],
              verification: { role: "test", worker: "backend_patch", required: true },
              result_policy: "structured",
            },
          ],
        },
      },
      execute: async (action) => ({
        title: action.title,
        output: "Verification test skipped.",
        metadata: { skipped: true },
      }),
    })

    expect(result.status).toBe("completed")
    expect(result.actions[0]).toMatchObject({
      id: "test_patch",
      status: "skipped",
      output: "Verification test skipped.",
      depends_on: ["backend_patch"],
      verification: { role: "test", worker: "backend_patch", required: true },
    })
  })

  test("blocks agent actions when no delegable agent matches", async () => {
    const result = await AgentProtocolExecutor.run({
      declaration: {
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        persist: false,
        title: "Delegate",
        execution: { strategy: "sequential" },
        payload: {
          type: "action_graph",
          actions: [
            {
              type: "action",
              id: "review",
              title: "Review",
              operation: "review_code",
              executor: { type: "agent", target: "auto", capabilities: ["typescript"] },
              depends_on: [],
              context_refs: [],
              result_policy: "summary",
            },
          ],
        },
      },
      agents: [{ id: "hidden", entry: { hidden: true }, capability: { purpose: "review_code", tags: ["typescript"] } }],
    })

    expect(result.status).toBe("blocked")
    expect(result.actions[0]?.error).toContain("No delegable agent")
  })

  test("executes human confirmation actions through the injected handler", async () => {
    const result = await AgentProtocolExecutor.run({
      declaration: {
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        persist: false,
        title: "Confirm",
        execution: { strategy: "sequential" },
        payload: {
          type: "action_graph",
          actions: [
            {
              type: "action",
              id: "confirm_plan",
              title: "Confirm plan",
              operation: "confirm",
              executor: { type: "human", target: "user", capabilities: ["confirmation"] },
              input: { prompt: "Approve?", plan: "Do the work." },
              depends_on: [],
              context_refs: [],
              result_policy: "summary",
            },
          ],
        },
      },
      execute: async (action) => ({
        title: action.title,
        output: `confirmed ${String(action.input?.plan)}`,
        metadata: { confirmed: true },
      }),
    })

    expect(result.status).toBe("completed")
    expect(result.actions[0]).toMatchObject({
      id: "confirm_plan",
      status: "completed",
      output: "confirmed Do the work.",
    })
  })
})
