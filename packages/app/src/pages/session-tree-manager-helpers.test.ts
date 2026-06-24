import { describe, expect, test } from "bun:test"
import { parseConflict, updateBody } from "./session-tree-manager-helpers"

describe("updateBody", () => {
  test("adds confirm when a model update is confirmed", () => {
    const body = updateBody({
      title: "",
      agent: "",
      agentChanged: false,
      providerID: "minimax-cn-coding-plan",
      modelID: "MiniMax-M3",
      modelChanged: true,
      confirm: true,
    })

    expect(body).toEqual({
      model: { providerID: "minimax-cn-coding-plan", modelID: "MiniMax-M3" },
      confirm: true,
    })
  })

  test("adds confirm when an agent update is confirmed", () => {
    const body = updateBody({
      title: "",
      agent: "plan",
      agentChanged: true,
      providerID: "",
      modelID: "",
      modelChanged: false,
      confirm: true,
    })

    expect(body).toEqual({ agent: "plan", confirm: true })
  })

  test("does not add confirm when only title changes", () => {
    const body = updateBody({
      title: "Renamed",
      agent: "",
      agentChanged: false,
      providerID: "",
      modelID: "",
      modelChanged: false,
      confirm: true,
    })

    expect(body).toEqual({ title: "Renamed" })
  })
})

describe("parseConflict", () => {
  test("parses model conflicts", () => {
    const result = parseConflict(
      JSON.stringify({
        name: "ConflictError",
        data: {
          message:
            'Session ses_1 has bound model "minimaxi-ultra/MiniMax-M3". Pass confirm=true to overwrite it with "minimax-cn-coding-plan/MiniMax-M3".',
        },
      }),
    )

    expect(result).toEqual({
      type: "model",
      current: "minimaxi-ultra/MiniMax-M3",
      next: "minimax-cn-coding-plan/MiniMax-M3",
    })
  })

  test("parses agent conflicts", () => {
    const result = parseConflict(
      JSON.stringify({
        data: {
          message: 'Session ses_1 has bound agent "build". Pass confirm=true to overwrite it with "plan".',
        },
      }),
    )

    expect(result).toEqual({ type: "agent", current: "build", next: "plan" })
  })
})
