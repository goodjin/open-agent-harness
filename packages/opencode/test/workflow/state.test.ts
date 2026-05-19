import { describe, expect, test } from "bun:test"
import { WorkflowState } from "../../src/workflow/state"

function run(id: string, started: number): WorkflowState.Info {
  return {
    runID: id,
    workflowID: id,
    workflowName: id,
    status: "completed",
    current: "done",
    step: 0,
    total: 1,
    variables: {},
    attempts: {},
    completed: ["done"],
    steps: [],
    nodes: {},
    statuses: { done: "completed" },
    time: { started, updated: started, completed: started },
  }
}

describe("workflow state", () => {
  test("keeps current workflow and historical runs", () => {
    const one = run("one", 1)
    const two = run("two", 2)
    const context = WorkflowState.write(WorkflowState.write(undefined, one), two)

    expect(WorkflowState.read(context)?.runID).toBe("two")
    expect(WorkflowState.list(context).map((item) => item.runID)).toEqual(["one", "two"])
  })

  test("hydrates legacy single workflow context into run history", () => {
    const one = run("one", 1)
    const two = run("two", 2)
    const context = WorkflowState.write({ workflow: one }, two)

    expect(WorkflowState.list(context).map((item) => item.runID)).toEqual(["one", "two"])
  })
})
