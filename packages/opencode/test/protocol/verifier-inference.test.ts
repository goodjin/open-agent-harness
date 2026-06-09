import { describe, expect, test } from "bun:test"
import { AgentProtocol } from "../../src/protocol/schema"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// Mirror of the runtime's verifier dependency validation logic. Kept in the test
// file because the helper itself is private inside SessionRunner. If the
// helper changes, this test must be updated to match.
async function issues(actions: AgentProtocol.Action[]) {
  const targets = new Map<string, AgentProtocol.Action>()
  const byID = new Map(actions.map((item) => [item.id, item] as const))
  for (const item of actions) {
    if (item.executor.type !== "agent") continue
    targets.set(item.executor.target, item)
  }
  const kindByTarget = new Map<string, string | undefined>()
  await Promise.all(
    [...targets.keys()].map(async (target) => {
      const agent = await Agent.get(target)
      kindByTarget.set(target, agent?.kind)
    }),
  )
  const kindByID = new Map(actions.map((item) => [item.id, item.executor.type === "agent" ? kindByTarget.get(item.executor.target) : undefined] as const))
  const out: { id: string; title: string; reason: string }[] = []
  for (const item of actions) {
    if (item.executor.type !== "agent") continue
    if (kindByTarget.get(item.executor.target) !== "verifier") continue
    const deps = item.depends_on.filter((dep) => byID.has(dep))
    const workers = deps.filter((dep) => kindByID.get(dep) === "worker")
    if (workers.length === 0) {
      out.push({ id: item.id, title: item.title, reason: `missing worker dependency` })
      continue
    }
    if (!item.executor.target.endsWith("-verifier")) continue
    const base = item.executor.target.slice(0, -"-verifier".length)
    const worker = targets.get(base)
    if (!worker || kindByTarget.get(worker.executor.target) !== "worker") {
      out.push({ id: item.id, title: item.title, reason: `missing worker '${base}'` })
      continue
    }
    if (!item.depends_on.includes(worker.id)) {
      out.push({ id: item.id, title: item.title, reason: `missing depends '${worker.id}'` })
    }
  }
  return out
}

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

describe("verifier dependency validation (runtime contract)", () => {
  test("rejects empty depends_on even when a matching worker exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const actions = parse({
          type: "agent.protocol",
          version: "1",
          intent: "execute",
          title: "Test",
          payload: {
            type: "action_graph",
            actions: [
              { id: "impl_1", type: "action", title: "Backend", operation: "do",
                executor: { type: "agent", target: "backend", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
              { id: "verify_1", type: "action", title: "Verify backend", operation: "verify",
                executor: { type: "agent", target: "backend-verifier", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        const r = await issues(actions)
        expect(actions.find((a) => a.id === "verify_1")?.depends_on).toEqual([])
        expect(r).toHaveLength(1)
        expect(r[0]?.id).toBe("verify_1")
        expect(r[0]?.reason).toContain("missing worker dependency")
      },
    })
  })

  test("rejects verifier when no matching worker is present in the graph", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const actions = parse({
          type: "agent.protocol",
          version: "1",
          intent: "execute",
          title: "Test",
          payload: {
            type: "action_graph",
            actions: [
              { id: "verify_1", type: "action", title: "Verify backend", operation: "verify",
                executor: { type: "agent", target: "backend-verifier", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        const r = await issues(actions)
        expect(r).toHaveLength(1)
        expect(r[0]?.id).toBe("verify_1")
        expect(r[0]?.reason).toContain("missing worker dependency")
      },
    })
  })

  test("accepts explicit depends_on for matching worker verifiers", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const actions = parse({
          type: "agent.protocol",
          version: "1",
          intent: "execute",
          title: "Test",
          payload: {
            type: "action_graph",
            actions: [
              { id: "impl_1", type: "action", title: "Backend", operation: "do",
                executor: { type: "agent", target: "backend", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
              { id: "review", type: "action", title: "Review", operation: "review",
                executor: { type: "agent", target: "backend-verifier", capabilities: [] },
                depends_on: ["impl_1"], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        expect(await issues(actions)).toEqual([])
      },
    })
  })

  test("rejects suffixed verifier that depends on the wrong worker", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const actions = parse({
          type: "agent.protocol",
          version: "1",
          intent: "execute",
          title: "Test",
          payload: {
            type: "action_graph",
            actions: [
              { id: "impl_1", type: "action", title: "Frontend", operation: "do",
                executor: { type: "agent", target: "frontend", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
              { id: "verify_1", type: "action", title: "Verify backend", operation: "verify",
                executor: { type: "agent", target: "backend-verifier", capabilities: [] },
                depends_on: ["impl_1"], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        const r = await issues(actions)
        expect(r).toHaveLength(1)
        expect(r[0]?.reason).toContain("backend")
      },
    })
  })

  test("accepts generic verifier when it depends on a worker", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const actions = parse({
          type: "agent.protocol",
          version: "1",
          intent: "execute",
          title: "Test",
          payload: {
            type: "action_graph",
            actions: [
              { id: "impl_1", type: "action", title: "Backend", operation: "do",
                executor: { type: "agent", target: "backend", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
              { id: "review", type: "action", title: "Review", operation: "review",
                executor: { type: "agent", target: "security-reviewer", capabilities: [] },
                depends_on: ["impl_1"], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        expect(await issues(actions)).toEqual([])
      },
    })
  })
})
