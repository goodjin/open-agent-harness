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
    expect(
      RequestFooter.variables({
        sessionID: "ses_test",
        agent: "release-runner-verifier",
        mode: "subagent",
        actionResult: {
          action: "cut_v0_4_1_release_test",
          verifier: true,
        },
        delegation: {
          action_id: "cut_v0_4_1_release_test",
          result_tool: "ActionResult",
        },
      }).action_result_example,
    ).toContain('"target_action_id": "cut_v0_4_1_release"')

    const missing = RequestFooter.variables({
      sessionID: "ses_final",
      agent: "verifier",
      mode: "subagent",
      actionResult: {
        action: "final_qa_check",
        verifier: true,
      },
      delegation: {
        action_id: "final_qa_check",
        result_tool: "ActionResult",
      },
    }).action_result_example
    expect(missing).toContain('"target_action_id": "worker_action_id"')
    expect(missing).toContain('"evidence"')
    expect(missing).not.toContain('"changed_files"')
  })
})
