import { describe, expect, test } from "bun:test"
import { graphRuns } from "./session-graph"

describe("graphRuns", () => {
  test("normalizes workflow runs into graph runs", () => {
    const runs = graphRuns({
      workflow: {
        runID: "wf_run",
        workflowID: "wf_review",
        workflowName: "Review workflow",
        status: "active",
        current: "verify",
        step: 1,
        total: 2,
        completed: ["inspect"],
        statuses: {
          inspect: "completed",
          verify: "running",
        },
        steps: [
          { id: "inspect", type: "research", agent: "explore", depends_on: [] },
          { id: "verify", type: "test", agent: "verifier", depends_on: ["inspect"] },
        ],
        nodes: {
          verify: {
            step: "verify",
            status: "running",
            agent: "verifier",
            sessionID: "ses_verify",
            path: "runs/wf_run/verify.json",
            attempt: 1,
            time: { started: 1, updated: 2 },
          },
        },
        time: { started: 1, updated: 2 },
      },
    })

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: "wf_run",
      title: "Review workflow",
      source: "workflow",
      status: "running",
      total: 2,
      completed: 1,
      metadata: {
        workflowID: "wf_review",
        workflowName: "Review workflow",
      },
    })
    expect(runs[0]?.nodes).toEqual([
      expect.objectContaining({ id: "inspect", status: "completed", deps: [] }),
      expect.objectContaining({ id: "verify", status: "running", deps: ["inspect"], sessionID: "ses_verify" }),
    ])
  })

  test("normalizes protocol runs into graph runs", () => {
    const runs = graphRuns({
      protocol: {
        runs: [
          {
            runID: "apr_1",
            title: "Protocol run",
            status: "completed",
            total: 2,
            completed: 2,
            actions: [
              {
                id: "inspect",
                title: "Inspect code",
                operation: "delegate",
                status: "completed",
                executor: { type: "agent", target: "explore" },
                time: { started: 1, completed: 2 },
              },
              {
                id: "verify",
                title: "Verify patch",
                operation: "delegate",
                status: "completed",
                executor: { type: "agent", target: "verifier" },
                time: { started: 3, completed: 4 },
              },
            ],
          },
        ],
      },
    })

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: "apr_1",
      title: "Protocol run",
      source: "protocol",
      status: "completed",
      total: 2,
      completed: 2,
    })
    expect(runs[0]?.nodes).toEqual([
      expect.objectContaining({ id: "inspect", title: "Inspect code", executor: "agent:explore" }),
      expect.objectContaining({ id: "verify", title: "Verify patch", executor: "agent:verifier" }),
    ])
  })
})
