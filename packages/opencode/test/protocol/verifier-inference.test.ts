import { describe, expect, test } from "bun:test"
import { AgentProtocol } from "../../src/protocol/schema"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// Mirror of the runtime's inferVerifierDependencies logic. Kept in the test
// file because the helper itself is private inside SessionRunner. If the
// helper changes, this test must be updated to match.
async function infer(actions: AgentProtocol.Action[]) {
  const result = actions.map((item) => ({ ...item, depends_on: [...item.depends_on] }))
  const targets = new Map<string, string>()
  for (const item of result) {
    if (item.executor.type !== "agent") continue
    targets.set(item.executor.target, item.id)
  }
  const kindByTarget = new Map<string, string | undefined>()
  await Promise.all(
    [...targets.keys()].map(async (target) => {
      const agent = await Agent.get(target)
      kindByTarget.set(target, agent?.kind)
    }),
  )
  const blocked: { id: string; title: string; reason: string }[] = []
  for (const item of result) {
    if (item.executor.type !== "agent") continue
    if (kindByTarget.get(item.executor.target) !== "verifier") continue
    if (item.depends_on.length > 0) continue
    if (!item.executor.target.endsWith("-verifier")) {
      blocked.push({ id: item.id, title: item.title, reason: `non-suffixed verifier` })
      continue
    }
    const base = item.executor.target.slice(0, -"-verifier".length)
    const workerID = targets.get(base)
    if (!workerID) {
      blocked.push({ id: item.id, title: item.title, reason: `missing worker '${base}'` })
      continue
    }
    if (workerID === item.id) continue
    item.depends_on = [workerID]
  }
  return { actions: result, blocked }
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

describe("verifier dependency inference (runtime contract)", () => {
  test("infers depends_on from matching worker base name", async () => {
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
        const r = await infer(actions)
        const verify = r.actions.find((a) => a.id === "verify_1")!
        expect(verify.depends_on).toEqual(["impl_1"])
        expect(r.blocked).toEqual([])
      },
    })
  })

  test("blocks verifier when no worker is present in the graph", async () => {
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
        const r = await infer(actions)
        const verify = r.actions.find((a) => a.id === "verify_1")!
        expect(verify.depends_on).toEqual([])
        expect(r.blocked).toHaveLength(1)
        expect(r.blocked[0]?.id).toBe("verify_1")
        expect(r.blocked[0]?.reason).toContain("backend")
      },
    })
  })

  test("preserves explicit depends_on for verifiers that already declared one", async () => {
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
                executor: { type: "agent", target: "sisyphus-verifier", capabilities: [] },
                depends_on: ["impl_1"], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        const r = await infer(actions)
        const review = r.actions.find((a) => a.id === "review")!
        expect(review.depends_on).toEqual(["impl_1"])
        expect(r.blocked).toEqual([])
      },
    })
  })

  test("non-suffixed verifiers (e.g. security-reviewer) are not auto-inferred and require explicit depends", async () => {
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
              { id: "review", type: "action", title: "Review", operation: "review",
                executor: { type: "agent", target: "security-reviewer", capabilities: [] },
                depends_on: [], context_refs: [], result_policy: "summary" },
            ],
          },
        })
        const r = await infer(actions)
        const review = r.actions.find((a) => a.id === "review")!
        // No worker with target "security-reviewer" exists; the verifier
        // must explicitly declare depends_on or set it to ["none"].
        expect(review.depends_on).toEqual([])
        expect(r.blocked).toHaveLength(1)
        expect(r.blocked[0]?.id).toBe("review")
      },
    })
  })
})
