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
})
