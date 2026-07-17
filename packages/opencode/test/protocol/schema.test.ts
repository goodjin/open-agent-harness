import { describe, expect, test } from "bun:test"
import path from "path"
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
  test("keeps assignment module documentation aligned with the v2 schema", async () => {
    const doc = await Bun.file(
      path.join(import.meta.dir, "../../../../docs/harness-module/protocol-runtime.md"),
    ).text()

    expect(doc).toMatch(/create\/self.*update\/self.*handoff\/peer/s)
    expect(doc).not.toMatch(/target\s*=\s*self\|<child-session-id>/)
  })

  test("accepts v2 items shape and normalizes tool agent and answer items", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "inspect", kind: "tool", target: "grep", args: { pattern: "Protocol" }, result: "full" },
        { id: "delegate", kind: "agent", target: "backend", prompt: "Inspect runner behavior.", depends: ["inspect"] },
        { id: "reply", kind: "answer", message: "Inspection is complete.", depends: ["delegate"] },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.message).toBe("Inspection is complete.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(
      out.payload.actions.map((item) => [item.id, item.executor.type, item.executor.target, item.depends_on]),
    ).toEqual([
      ["inspect", "tool", "grep", []],
      ["delegate", "agent", "backend", ["inspect"]],
    ])
    expect(out.payload.actions[0]?.input).toEqual({ pattern: "Protocol" })
    expect(out.payload.actions[0]?.result_policy).toBe("full")
    expect(out.payload.actions[1]?.input).toEqual({ prompt: "Inspect runner behavior." })
  })

  test("preserves verifier metadata from v2 agent items", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "worker", kind: "agent", target: "backend", prompt: "Patch the API." },
        {
          id: "worker_review",
          kind: "agent",
          target: "backend-verifier",
          prompt: "Review the backend patch.",
          depends: ["worker"],
          verification: { role: "review", worker: "worker", required: true },
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[1]?.verification).toEqual({
      role: "review",
      worker: "worker",
      required: true,
    })
  })

  test("normalizes v2 tool items with prompts as agent delegation", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "inspect_repo_layout",
          kind: "tool",
          target: "general-investigator",
          prompt: "Inspect the repo layout and report facts.",
          result: "structured",
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "inspect_repo_layout",
      operation: "general-investigator",
      executor: { type: "agent", target: "general-investigator", capabilities: [] },
      input: { prompt: "Inspect the repo layout and report facts." },
      result_policy: "structured",
    })
  })

  test("ignores whitespace-only v2 item strings", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "worker", kind: "agent", target: "backend", prompt: "Patch the API.\nKeep the prompt newline." },
        "\n",
        {
          id: "worker_review",
          kind: "agent",
          target: "backend-verifier",
          prompt: "Review the backend patch.",
          depends: ["worker"],
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions.map((item) => item.id)).toEqual(["worker", "worker_review"])
    expect(out.payload.actions[0]?.input).toEqual({ prompt: "Patch the API.\nKeep the prompt newline." })
    expect(out.payload.actions[1]?.depends_on).toEqual(["worker"])
  })

  test("treats v2 dependencies on answer items as no dependency", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "ack", kind: "answer", message: "Acknowledged." },
        { id: "dispatch", kind: "agent", target: "backend", prompt: "Continue work.", depends: ["ack"] },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.message).toBe("Acknowledged.")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions).toHaveLength(1)
    expect(out.payload.actions[0]?.id).toBe("dispatch")
    expect(out.payload.actions[0]?.depends_on).toEqual([])
  })

  test("rejects non-empty v2 item strings", () => {
    expect(() =>
      AgentProtocol.parse({
        version: "2",
        items: [{ id: "worker", kind: "agent", target: "backend", prompt: "Patch the API." }, "run this"],
      }),
    ).toThrow()
  })

  test("ignores extra v2 protocol fields when required fields are valid", () => {
    const out = AgentProtocol.parse({
      version: "2",
      kind: "answer",
      ignored: true,
      items: [
        {
          id: "summary",
          kind: "answer",
          message: "Done.",
          extra: "ignored",
        },
      ],
    })

    expect(out.intent).toBe("respond")
    expect(out.message).toBe("Done.")
    expect(out.payload.type).toBe("message")
  })

  test("accepts v2 input item and maps it to a human input action", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "choose_scope",
          kind: "input",
          prompt: "Which scope should I optimize?",
          mode: "multi",
          options: [
            { id: "schema", label: "Schema" },
            { id: "prompt", label: "Prompt" },
          ],
          min_selected: 1,
          max_selected: 2,
        },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "choose_scope",
      title: "choose_scope",
      operation: "input",
      executor: { type: "human", target: "user", capabilities: ["multi"] },
      input: {
        prompt: "Which scope should I optimize?",
        mode: "multi",
        options: [
          { id: "schema", label: "Schema" },
          { id: "prompt", label: "Prompt" },
        ],
        min_selected: 1,
        max_selected: 2,
      },
    })
  })

  test("keeps legacy v2 ask compatible without exposing it publicly", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "legacy_question",
          kind: "ask",
          prompt: "Which legacy scope?",
          mode: "single",
          options: [{ id: "one", label: "One" }],
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "legacy_question",
      operation: "input",
      executor: { type: "human", target: "user", capabilities: ["single"] },
    })
  })

  test("keeps legacy v2 wait compatible for explicit runtime rejection", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "legacy_wait",
          kind: "wait",
          target: "child_done",
          reason: "Wait for a historical event target.",
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "legacy_wait",
      operation: "child_done",
      executor: { type: "runtime", target: "wait", capabilities: [] },
      input: { target: "child_done", reason: "Wait for a historical event target." },
    })
  })

  test("public v2 output schema exposes current items shape only", () => {
    const item = AgentProtocol.OutputSchema.properties.items.items.properties.kind
    expect(item.enum).toContain("input")
    expect(item.enum).not.toContain("ask")
    expect(item.enum).not.toContain("wait")
    const mode = AgentProtocol.OutputSchema.properties.items.items.properties.mode
    expect(mode.enum).not.toContain("confirm")
    expect("kind" in AgentProtocol.OutputSchema.properties).toBe(false)
    expect("calls" in AgentProtocol.OutputSchema.properties).toBe(false)
    expect(AgentProtocol.OutputSchema.required).toEqual(["version", "items"])
    const assignment = AgentProtocol.OutputSchema.properties.items.items.properties.assignment
    expect(assignment.properties.op.enum).toEqual(["create", "update", "handoff"])
    expect(assignment.properties.target.enum).toEqual(["self", "peer"])
  })

  test("accepts v2 confirm item and maps it to a human confirmation action", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "confirm_plan",
          kind: "confirm",
          title: "Confirm plan",
          prompt: "Confirm this plan before execution.",
          plan: "1. Inspect the runner.\n2. Patch the schema.",
        },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "confirm_plan",
      title: "Confirm plan",
      operation: "confirm",
      executor: { type: "human", target: "user", capabilities: ["confirmation"] },
      input: {
        prompt: "Confirm this plan before execution.",
        plan: "1. Inspect the runner.\n2. Patch the schema.",
      },
    })
  })

  test("accepts v2 confirm assignment metadata", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "confirm_assignment",
          kind: "confirm",
          title: "Confirm assignment",
          prompt: "Confirm this assignment before execution.",
          plan: "Implement the assignment lifecycle with persistence and runtime gates.",
          assignment: {
            op: "create",
            target: "self",
          },
        },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "confirm_assignment",
      operation: "confirm",
      input: {
        assignment: {
          op: "create",
          target: "self",
        },
      },
    })
  })

  test("accepts create and update assignments for the current session task", () => {
    ;["create", "update"].forEach((op) => {
      const out = AgentProtocol.parse({
        version: "2",
        items: [
          {
            id: `confirm_${op}`,
            kind: "confirm",
            prompt: `Confirm the ${op} proposal.`,
            plan: `# ${op} task\n`,
            assignment: { op },
          },
        ],
      })

      expect(out.payload.type).toBe("action_graph")
      if (out.payload.type !== "action_graph") return
      expect(out.payload.actions[0]?.input).toMatchObject({ assignment: { op, target: "self" } })
    })
  })

  test("accepts handoff assignment for a peer session", () => {
    const out = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "confirm_handoff",
          kind: "confirm",
          prompt: "Create a peer task session?",
          plan: "# New task\n",
          assignment: { op: "handoff", target: "peer" },
        },
      ],
    })

    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]?.input).toMatchObject({
      assignment: { op: "handoff", target: "peer" },
    })
  })

  test("rejects assignment operation and target combinations outside the task contract", () => {
    ;[
      { op: "handoff", target: "self" },
      { op: "handoff" },
      { op: "create", target: "peer" },
      { op: "update", target: "peer" },
      { op: "replace", target: "self" },
      { op: "create", target: "self", extra: true },
    ].forEach((assignment) => {
      expect(() =>
        AgentProtocol.parse({
          version: "2",
          items: [
            {
              id: "confirm_assignment",
              kind: "confirm",
              prompt: "Confirm the task proposal.",
              plan: "# Task proposal\n",
              assignment,
            },
          ],
        }),
      ).toThrow()
    })
  })

  test("explains which assignment target combination is invalid", () => {
    const parse = (assignment: Record<string, string | undefined>) =>
      AgentProtocol.parse({
        version: "2",
        items: [
          {
            id: "confirm_assignment",
            kind: "confirm",
            prompt: "Confirm the task proposal.",
            plan: "# Task proposal\n",
            assignment,
          },
        ],
      })

    ;[{ op: "handoff", target: "self" }, { op: "handoff" }].forEach((assignment) => {
      expect(() => parse(assignment)).toThrow("handoff requires target=peer")
    })
    ;[
      { op: "create", target: "peer" },
      { op: "update", target: "peer" },
    ].forEach((assignment) => {
      expect(() => parse(assignment)).toThrow("target=peer is only valid for handoff")
    })
  })

  test("accepts flat act shape and normalizes it to one runtime action", () => {
    const out = AgentProtocol.parse({
      kind: "act",
      message: "I need to inspect files.",
      calls: [{ id: "inspect", type: "tool", name: "grep", args: { pattern: "SessionRunner" }, result: "full" }],
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
        {
          id: "read",
          type: "tool",
          name: "read",
          args: { filePath: "package.json" },
          depends: "find",
          result: "summary",
        },
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
        {
          id: "review",
          type: "agent",
          name: "auto",
          args: { description: "Review the changed code" },
          result: "summary",
        },
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

  test("accepts v2 terminal result kinds", () => {
    const success = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "done",
          kind: "success",
          message: "Worker completed.",
          summary: "Task background: user request.\nCompletion summary: changed code.",
          changed_files: ["src/a.ts"],
        },
      ],
    })
    expect(success.intent).toBe("stop")
    expect(success.outcome).toBe("success")
    expect(success.message).toContain("Worker completed.")
    expect(success.message).toContain("Changed files: src/a.ts")

    const text = AgentProtocol.parse({
      version: "2",
      items: [
        {
          id: "done",
          kind: "success",
          message: "Worker completed.",
          changed_files: "src/a.ts; src/b.ts\nsrc/c.ts",
        },
      ],
    })
    expect(text.intent).toBe("stop")
    expect(text.message).toContain("Changed files: src/a.ts, src/b.ts, src/c.ts")

    const reply = AgentProtocol.parse({
      version: "2",
      items: [{ id: "reply", kind: "reply", message: "Need more context." }],
    })
    expect(reply.intent).toBe("respond")
    expect(reply.outcome).toBe("reply")

    const failure = AgentProtocol.parse({
      version: "2",
      items: [{ id: "fail", kind: "failure", message: "Could not complete." }],
    })
    expect(failure.intent).toBe("stop")
    expect(failure.outcome).toBe("failure")

    const error = AgentProtocol.parse({
      kind: "error",
      message: "Runtime crashed.",
    })
    expect(error.intent).toBe("stop")
    expect(error.outcome).toBe("error")
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

  test("keeps versioned legacy act calls parseable without exposing them publicly", () => {
    const out = AgentProtocol.parse({
      version: "2",
      kind: "act",
      calls: [
        {
          id: "write_doc",
          type: "agent",
          title: "Write docs",
          name: "docs-maintainer",
          args: {
            depends: ["inspect"],
            result: "structured",
          },
        },
      ],
    })

    expect(out.intent).toBe("execute")
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]).toMatchObject({
      id: "write_doc",
      title: "Write docs",
      operation: "agent",
      executor: { type: "agent", target: "docs-maintainer", capabilities: [] },
      input: {
        depends: ["inspect"],
        result: "structured",
        prompt: "Write docs",
      },
      depends_on: ["inspect"],
      result_policy: "structured",
    })
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

  test("rejects duplicate action ids and preserves external dependencies for runtime validation", () => {
    expect(() =>
      AgentProtocol.parse({
        type: "agent.protocol",
        version: "1",
        intent: "execute",
        execution: { strategy: "sequential" },
        payload: { type: "action_graph", actions: [action, { ...action, depends_on: ["missing"] }] },
      }),
    ).toThrow("duplicate action id")

    const out = AgentProtocol.parse({
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      execution: { strategy: "sequential" },
      payload: { type: "action_graph", actions: [{ ...action, depends_on: ["missing"] }] },
    })
    expect(out.payload.type).toBe("action_graph")
    if (out.payload.type !== "action_graph") return
    expect(out.payload.actions[0]?.depends_on).toEqual(["missing"])
  })
})
