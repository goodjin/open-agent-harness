import { describe, expect, test } from "bun:test"
import { AgentProtocol } from "../../src/protocol/schema"

const action = {
  type: "action",
  id: "inspect",
  title: "Inspect files",
  description: "Find the relevant files.",
  operation: "search",
  executor: { type: "tool", target: "grep", capabilities: ["filesystem.search"] },
  input: { pattern: "SessionRunner" },
  depends_on: [],
  context_refs: ["input:user.goal"],
  prompt_ref: "md:inspect",
  result_policy: "summary",
}

describe("agent protocol schema", () => {
  test("accepts a minimal v1 action graph declaration", () => {
    const out = AgentProtocol.parse({
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      persist: false,
      title: "Inspect",
      execution: { strategy: "sequential" },
      payload: {
        type: "action_graph",
        actions: [action],
      },
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]?.id).toBe("inspect")
    expect(out.payload.actions[0]?.executor.type).toBe("tool")
    expect(out.payload.actions[0]?.input).toEqual({ pattern: "SessionRunner" })
  })

  test("accepts structured output shape and normalizes it", () => {
    const out = AgentProtocol.parse({
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      title: "Inspect",
      message: "I need to inspect files.",
      actions: [action],
    })

    expect(out.message).toBe("I need to inspect files.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]?.id).toBe("inspect")
  })

  test("accepts respond and stop message declarations", () => {
    const out = AgentProtocol.parse({
      type: "agent.protocol.output",
      version: "1",
      intent: "respond",
      title: "Answer",
      response_ref: "md:response",
      payload: { type: "message" },
    })

    expect(out.intent).toBe("respond")
    expect(out.response_ref).toBe("md:response")
    expect(out.payload.type).toBe("message")

    expect(
      AgentProtocol.parse({
        type: "agent.protocol.output",
        version: "1",
        intent: "stop",
        payload: { type: "message" },
      }).intent,
    ).toBe("stop")
  })

  test("rejects mismatched intent and payload", () => {
    expect(() =>
      AgentProtocol.parse({
        type: "agent.protocol.output",
        version: "1",
        intent: "respond",
        payload: { type: "action_graph", actions: [action] },
      }),
    ).toThrow("respond intent requires message payload")

    expect(() =>
      AgentProtocol.parse({
        type: "agent.protocol.output",
        version: "1",
        intent: "execute",
        payload: { type: "message" },
      }),
    ).toThrow("execute intent requires action_graph payload")
  })

  test("rejects duplicate action ids and missing dependencies", () => {
    expect(() =>
      AgentProtocol.parse({
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        execution: { strategy: "sequential" },
        payload: { type: "action_graph", actions: [action, { ...action, depends_on: ["missing"] }] },
      }),
    ).toThrow("duplicate action id")

    expect(() =>
      AgentProtocol.parse({
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        execution: { strategy: "sequential" },
        payload: { type: "action_graph", actions: [{ ...action, depends_on: ["missing"] }] },
      }),
    ).toThrow("missing dependency")
  })
})
