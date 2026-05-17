import { describe, expect, test } from "bun:test"
import { HeaderStatus } from "../../../src/cli/cmd/tui/routes/session/header-status"
import { WorkflowProgress } from "../../../src/cli/cmd/tui/routes/session/workflow-progress"

describe("tui header status", () => {
  test("aggregates visible child permission pending", () => {
    const status = HeaderStatus.resolve({
      current: { type: "idle" },
      route: { id: "parent" },
      sessions: [{ id: "parent" }, { id: "child", parentID: "parent" }],
      permission: { child: [{}] },
      question: {},
    })

    expect(status.type).toBe("waiting_permission")
  })

  test("aggregates visible child question pending", () => {
    const status = HeaderStatus.resolve({
      current: { type: "idle" },
      route: { id: "parent" },
      sessions: [{ id: "parent" }, { id: "child", parentID: "parent" }],
      permission: {},
      question: { child: [{}] },
    })

    expect(status.type).toBe("waiting_user")
  })

  test("uses route session status when visible children are not pending", () => {
    const status = HeaderStatus.resolve({
      current: { type: "running" },
      route: { id: "parent" },
      sessions: [{ id: "parent" }, { id: "child", parentID: "parent" }],
      permission: {},
      question: {},
    })

    expect(status.type).toBe("running")
  })

  test("shows workflow progress label", () => {
    expect(
      WorkflowProgress.label({
        workflow: {
          workflowName: "Ship",
          status: "waiting_user",
          current: "review",
          step: 1,
          total: 3,
          pause: {
            reason: "Need answer",
          },
        },
      }),
    ).toBe("Ship 2/3: review (Need answer)")
  })
})
