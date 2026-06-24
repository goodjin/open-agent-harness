import { describe, expect, test } from "bun:test"
import { RequestFooter } from "../../src/session/request-footer"

describe("RequestFooter", () => {
  test("renders simple variables and leaves missing values empty", () => {
    expect(
      RequestFooter.render("Action {{action_id}} uses {{result_tool}} {{missing}}", {
        action_id: "impl",
        result_tool: "ActionResult",
      }),
    ).toBe("Action impl uses ActionResult ")
  })

  test("builds action result examples from delegation context", () => {
    expect(
      RequestFooter.variables({
        sessionID: "ses_child",
        agent: "backend",
        mode: "subagent",
        delegation: {
          action_id: "impl",
          result_tool: "ActionResult",
        },
      }).action_result_example,
    ).toContain('"action_id": "impl"')

    expect(
      RequestFooter.variables({
        sessionID: "ses_review",
        agent: "backend-verifier",
        mode: "subagent",
        actionResult: {
          action: "impl_review",
          target: "impl",
          verifier: true,
        },
        delegation: {
          action_id: "impl_review",
          result_tool: "ActionResult",
          depends_on: ["impl"],
          metadata: {
            verification: {
              worker: "impl",
            },
          },
        },
      }).action_result_example,
    ).toContain('"target_action_id": "impl"')
    expect(
      RequestFooter.variables({
        sessionID: "ses_impl",
        agent: "backend",
        mode: "subagent",
        actionResult: {
          action: "impl",
          verifier: false,
        },
        delegation: {
          action_id: "impl",
          result_tool: "ActionResult",
          metadata: {
            verification: {
              worker: "other",
            },
          },
        },
      }).action_result_example,
    ).not.toContain("target_action_id")
    expect(
      RequestFooter.variables({
        sessionID: "ses_review",
        agent: "backend-verifier",
        mode: "subagent",
        delegation: {
          action_id: "impl_review",
          result_tool: "ActionResult",
          depends_on: ["impl"],
        },
      }).action_result_example,
    ).toContain('"status": "success"')
  })
})
