import { describe, expect, test } from "bun:test"
import { AgentConcurrency } from "../../src/protocol/agent-concurrency"

describe("AgentConcurrency", () => {
  test("defaults ordinary planners to one concurrent task", () => {
    expect(AgentConcurrency.limit({ agent: "milestone-planner", kind: "planner" })).toBe(1)
    expect(AgentConcurrency.limit({ agent: "epic-planner", kind: "planner" })).toBe(1)
  })

  test("defaults feature planner to two concurrent tasks", () => {
    expect(AgentConcurrency.limit({ agent: "feature-planner", kind: "planner" })).toBe(2)
  })

  test("defaults workers to three concurrent tasks", () => {
    expect(AgentConcurrency.limit({ agent: "backend", kind: "worker" })).toBe(3)
    expect(AgentConcurrency.limit({ agent: "frontend", kind: "worker" })).toBe(3)
  })

  test("uses agent metadata override before defaults", () => {
    expect(AgentConcurrency.limit({ agent: "feature-planner", kind: "planner", cfg: { concurrency: 4 } })).toBe(4)
  })

  test("counts only same-agent pending sessions", () => {
    expect(
      AgentConcurrency.running("backend", [
        { action_id: "a", agent: "backend" },
        { action_id: "b", agent: "frontend" },
        { action_id: "c", agent: "backend" },
      ]),
    ).toBe(2)
  })

  test("blocks agent when dependency action is still pending", () => {
    const out = AgentConcurrency.block({
      action: "feature_2",
      agent: "feature-planner",
      kind: "planner",
      depends: ["feature_1"],
      completed: new Set(["confirm_plan"]),
      done: [],
      pending: [{ action_id: "feature_1", agent: "feature-planner" }],
      running: 1,
    })

    expect(out?.reason).toBe("agent_dependency_pending")
  })

  test("blocks agent when same-agent running count reaches limit", () => {
    const out = AgentConcurrency.block({
      action: "feature_3",
      agent: "feature-planner",
      kind: "planner",
      depends: ["confirm_plan"],
      completed: new Set(["confirm_plan"]),
      done: [],
      pending: [],
      running: 2,
    })

    expect(out?.reason).toBe("agent_concurrency_limit")
    expect(out?.limit).toBe(2)
  })

  test("allows worker when other agents are running but same-agent count is below limit", () => {
    const out = AgentConcurrency.block({
      action: "backend_2",
      agent: "backend",
      kind: "worker",
      depends: ["confirm_plan"],
      completed: new Set(["confirm_plan"]),
      done: [],
      pending: [],
      running: 2,
    })

    expect(out).toBeUndefined()
  })
})
