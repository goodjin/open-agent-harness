import { describe, expect, test } from "bun:test"
import { AgentDelegation } from "../../src/agent/delegation"

const all = [
  agent("default", true),
  agent("build", true),
  agent("plan", true),
  agent("milestone-planner"),
  agent("epic-planner"),
  agent("feature-planner"),
  agent("backend"),
  agent("frontend"),
]

function agent(name: string, primary = false) {
  return {
    name,
    entry: {
      primary,
      delegable: true,
      hidden: false,
    },
  }
}

function names(agent: string) {
  return AgentDelegation.list(all, agent).map((item) => item.name)
}

describe("agent delegation visibility", () => {
  test("default sees primary delegable agents and subtask agents", () => {
    expect(names("default")).toEqual([
      "build",
      "plan",
      "milestone-planner",
      "epic-planner",
      "feature-planner",
      "backend",
      "frontend",
    ])
  })

  test("milestone planner sees delegable agents except itself and upstream agents", () => {
    expect(names("milestone-planner")).toEqual([
      "build",
      "plan",
      "epic-planner",
      "feature-planner",
      "backend",
      "frontend",
    ])
  })

  test("epic planner sees delegable agents except itself and upstream agents", () => {
    expect(names("epic-planner")).toEqual([
      "build",
      "plan",
      "feature-planner",
      "backend",
      "frontend",
    ])
  })

  test("feature planner sees delegable agents except itself and upstream agents", () => {
    expect(names("feature-planner")).toEqual(["build", "plan", "backend", "frontend"])
  })

  test("runtime metadata gates delegated assignment before launch", () => {
    const got = AgentDelegation.runtime({
      agent: "researcher",
      meta: {
        contracts: {
          input: [{ name: "brief", required: true }],
          output: [],
        },
        collaboration: {
          edges: [{ kind: "prerequisite", trigger: "missing_input", target: "collector", required: true }],
        },
        runtime_boundary: {
          resource_classes: ["network"],
          actions: { network: ["read"] },
        },
        observability: {
          level: "minimal",
        },
      },
      action: {
        id: "act_research",
        title: "Research",
        operation: "research",
        executor: { type: "agent", target: "researcher", capabilities: [] },
        input: {},
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      },
      run: { allow: [{ resource: "network", action: "read" }] },
      project: { allow: [{ resource: "network", action: "read" }] },
      trigger: "missing_input",
    })

    expect(got.input.status).toBe("prerequisite")
    expect(got.status).toBe("prerequisite")
    expect(got.collaboration.items.map((item) => item.target)).toEqual(["collector"])
    expect(got.boundary.candidates[0]).toEqual({
      resource: "network",
      action: "read",
      status: "allowed",
      reason: "policy_allowed",
    })
    expect(got.observability.log_level).toBe("warn")
  })

  test("runtime metadata validates outputs before marking completion", () => {
    const got = AgentDelegation.complete({
      agent: "tester",
      meta: {
        contracts: {
          input: [],
          output: [
            {
              name: "report",
              required: true,
              artifact_type: "verification_report",
              content_type: "text/markdown",
            },
          ],
        },
        completion: {
          criteria: [],
          required_artifacts: ["report"],
          required_evidence: ["test"],
          gates: [],
        },
      },
      result: {
        content: "Checked manually.",
        metadata: {
          artifact: {
            name: "report",
            artifact_type: "verification_report",
            content_type: "text/markdown",
          },
        },
      },
      status: "completed",
    })

    expect(got.validation.status).toBe("partial")
    expect(got.completion.status).toBe("partial")
    expect(got.completion.missing_evidence).toEqual(["test"])
    expect(got.status).toBe("partial")
  })

  test("completion rejection creates a follow-up assignment plan", () => {
    const got = AgentDelegation.complete({
      agent: "tester",
      meta: {
        contracts: {
          input: [],
          output: [
            {
              name: "report",
              required: true,
              artifact_type: "verification_report",
            },
            {
              name: "log",
              required: true,
              artifact_type: "execution_log",
            },
          ],
        },
        collaboration: {
          edges: [
            {
              kind: "recovery",
              trigger: "output_validation_failed",
              target: "fixer",
              input: { prompt: "Repair missing report" },
              depends: ["act_verify"],
            },
          ],
        },
      },
      result: "No structured artifact.",
      status: "completed",
    })

    expect(got.status).toBe("partial")
    expect(got.followup?.items).toEqual([
      {
        kind: "action",
        id: "tester-recovery-fixer",
        edge_kind: "recovery",
        target: "fixer",
        required: false,
        failure_policy: "retry",
        dedupe_key: "tester:recovery:fixer",
        depends: ["act_verify"],
        trigger: "output_validation_failed",
        input: { prompt: "Repair missing report" },
        source: {
          agent: "tester",
          depth: 1,
        },
      },
    ])
  })
})
