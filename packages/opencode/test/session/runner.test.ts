import { describe, expect, test } from "bun:test"
import { SessionRunner } from "../../src/session/runner"

describe("SessionRunner", () => {
  test("selects chat for ordinary agents", () => {
    expect(SessionRunner.select({})).toBe("chat")
    expect(SessionRunner.select({ runner: "chat" })).toBe("chat")
  })

  test("selects workflow for workflow-runner agents", () => {
    expect(SessionRunner.select({ runner: "workflow" })).toBe("workflow")
  })

  test("dispatches ordinary agents to chat without changing chat result", () => {
    const seen: string[] = []
    const result = SessionRunner.dispatch(
      { agent: {} },
      {
        chat: () => {
          seen.push("chat")
          return "continue"
        },
        workflow: () => {
          seen.push("workflow")
          return "stop"
        },
      },
    )

    expect(result).toBe("continue")
    expect(seen).toEqual(["chat"])
  })

  test("dispatches workflow-runner agents to workflow", () => {
    const seen: string[] = []
    const result = SessionRunner.dispatch(
      { agent: { runner: "workflow" } },
      {
        chat: () => {
          seen.push("chat")
          return "continue"
        },
        workflow: () => {
          seen.push("workflow")
          return "continue"
        },
      },
    )

    expect(result).toBe("continue")
    expect(seen).toEqual(["workflow"])
  })
})
