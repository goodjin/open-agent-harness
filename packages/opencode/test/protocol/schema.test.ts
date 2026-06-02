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
  test("accepts flat act shape and normalizes it to one runtime action", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "I need to inspect files.",
      calls: [
        { id: "inspect", type: "tool", name: "grep", args: { pattern: "SessionRunner" }, result: "full" },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.message).toBe("I need to inspect files.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions).toHaveLength(1)
    expect(out.payload.actions[0]).toMatchObject({
      id: "inspect",
      title: "inspect",
      operation: "grep",
      executor: { type: "tool", target: "grep", capabilities: [] },
      input: { pattern: "SessionRunner" },
      depends_on: [],
      context_refs: [],
      result_policy: "full",
    })
  })

  test("accepts flat act calls and normalizes simple dependencies", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "I will inspect the project files.",
      calls: [
        { id: "find", type: "tool", name: "glob", args: { pattern: "*.json" } },
        { id: "read", type: "tool", name: "read", args: { filePath: "package.json" }, depends: "find", result: "summary" },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.message).toBe("I will inspect the project files.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => item.id)).toEqual(["find", "read"])
    expect(out.payload.actions[0]).toMatchObject({
      title: "find",
      operation: "glob",
      executor: { type: "tool", target: "glob", capabilities: [] },
      input: { pattern: "*.json" },
      depends_on: [],
      result_policy: "summary",
    })
    expect(out.payload.actions[1]).toMatchObject({
      title: "read",
      operation: "read",
      executor: { type: "tool", target: "read", capabilities: [] },
      input: { filePath: "package.json" },
      depends_on: ["find"],
      result_policy: "summary",
    })
  })

  test("accepts calls encoded as a JSON array string", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "I will inspect the package files.",
      calls: JSON.stringify([
        { id: "read_package", type: "tool", name: "read", args: { filePath: "package.json" }, result: "summary" },
        { id: "read_readme", type: "tool", name: "read", args: { filePath: "README.md" }, depends: "read_package" },
      ]),
    })

    expect(out.intent).toBe("execute")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => [item.id, item.executor.target, item.depends_on])).toEqual([
      ["read_package", "read", []],
      ["read_readme", "read", ["read_package"]],
    ])
  })

  test("accepts calls string with raw control characters inside prompts", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "Continue with parser work.",
      calls:
        '[{"id":"implement_parser","type":"agent","name":"backend","args":{"prompt":"Read the guide.\nThen implement the parser.\tKeep errors useful."},"result":"summary"}]',
    })

    expect(out.intent).toBe("execute")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "implement_parser",
      executor: { type: "agent", target: "backend", capabilities: [] },
      input: { prompt: "Read the guide.\nThen implement the parser.\tKeep errors useful." },
    })
  })

  test("recovers flat output wrapped in input string", () => {
    const out = AgentProtocol.parse({
      input: JSON.stringify({
        kind: "act",
        message: "I will inspect the package file.",
        calls: [
          { id: "read_package", type: "tool", name: "read", args: { filePath: "package.json" }, result: "summary" },
        ],
      }),
    })

    expect(out.intent).toBe("execute")
    expect(out.message).toBe("I will inspect the package file.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "read_package",
      operation: "read",
      executor: { type: "tool", target: "read", capabilities: [] },
      input: { filePath: "package.json" },
    })
  })

  test("rejects unrecoverable input wrappers", () => {
    expect(() => AgentProtocol.parse({ input: "not json" })).toThrow()
    expect(() =>
      AgentProtocol.parse({
        input: JSON.stringify({ kind: "act", message: "Missing calls." }),
      }),
    ).toThrow()
  })

  test("repairs flat calls missing call closing braces", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "Delegate two reviews.",
      calls:
        '[{"id":"review_a","type":"agent","name":"auto","args":{"description":"A","subagent_type":"general","depends":[]}, {"id":"review_b","type":"agent","name":"auto","args":{"description":"B","subagent_type":"general","depends":[]}]',
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => item.id)).toEqual(["review_a", "review_b"])
    expect(out.payload.actions[0]).toMatchObject({
      operation: "general",
      executor: { type: "agent", target: "auto", capabilities: ["general"] },
      input: { description: "A", subagent_type: "general", depends: [] },
    })
  })

  test("repairs flat calls missing closing braces before dependency-first calls", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "Continue implementation.",
      calls:
        '[{"id":"write_sample","type":"agent","name":"frontend","args":{"prompt":"Write files"}}, {"depends":["write_sample"],"id":"verify_sample","type":"agent","name":"verifier","args":{"prompt":"Verify files"}}]',
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => [item.id, item.depends_on])).toEqual([
      ["write_sample", []],
      ["verify_sample", ["write_sample"]],
    ])
  })

  test("accepts flat agent calls", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "I will delegate the review.",
      calls: [
        { id: "review", type: "agent", name: "auto", args: { description: "Review the changed code" }, result: "summary" },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "review",
      title: "review",
      operation: "agent",
      executor: { type: "agent", target: "auto", capabilities: [] },
      input: { description: "Review the changed code" },
      result_policy: "summary",
    })
  })

  test("maps flat agent subagent_type into routing capability", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "Delegate the review.",
      calls: [
        {
          id: "review",
          type: "agent",
          name: "auto",
          args: { description: "Review the changed code", subagent_type: "general" },
          result: "summary",
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      operation: "general",
      executor: { type: "agent", target: "auto", capabilities: ["general"] },
    })
  })

  test("normalizes legacy task tool calls into agent calls", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "Delegate review.",
      calls: [
        {
          id: "review",
          type: "tool",
          name: "task",
          args: { description: "Review code", prompt: "Review code", subagent_type: "code-review" },
          result: "summary",
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      operation: "code-review",
      executor: { type: "agent", target: "auto", capabilities: ["code-review"] },
      input: { description: "Review code", prompt: "Review code", subagent_type: "code-review" },
    })
  })

  test("accepts flat answer and done shapes", () => {
    const answer = AgentProtocol.parse({
      kind: "answer",
      message: "The project is a VS Code extension.",
    })

    expect(answer.intent).toBe("respond")
    expect(answer.message).toBe("The project is a VS Code extension.")
    expect(answer.payload.type).toBe("message")

    const done = AgentProtocol.parse({ kind: "done", message: "No more work is needed." })
    expect(done.intent).toBe("stop")
    expect(done.message).toBe("No more work is needed.")
    expect(done.payload.type).toBe("message")
  })

  test("accepts legacy flat field names for compatibility", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      say: "I will inspect files.",
      calls: [
        { id: "find", kind: "tool", tool: "glob", args: { pattern: "*.json" } },
        { id: "read", kind: "tool", name: "read", args: { filePath: "package.json" }, after: "find" },
      ],
    })

    expect(out.message).toBe("I will inspect files.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => [item.id, item.executor.target, item.depends_on])).toEqual([
      ["find", "glob", []],
      ["read", "read", ["find"]],
    ])
  })

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

  test("accepts structured output actions encoded as json text", () => {
    const out = AgentProtocol.parse({
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      title: "Inspect",
      actions: JSON.stringify([action]),
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]?.id).toBe("inspect")
  })

  test("repairs structured output actions missing action closing braces", () => {
    const out = AgentProtocol.parse({
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      title: "Inspect",
      actions:
        `[{"type":"action","id":"inspect","title":"Inspect files","description":"Find the relevant files.","operation":"search","executor":{"type":"tool","target":"grep","capabilities":["filesystem.search"]},"input":{"pattern":"SessionRunner"},"depends_on":[],"context_refs":["input:user.goal"],"prompt_ref":"md:inspect","result_policy":"summary"` +
        `,{"type":"action","id":"read","title":"Read files","operation":"read","executor":{"type":"tool","target":"read","capabilities":["filesystem.read"]},"input":{"filePath":"package.json"},"depends_on":["inspect"],"context_refs":[],"result_policy":"summary"}]`,
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => item.id)).toEqual(["inspect", "read"])
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
