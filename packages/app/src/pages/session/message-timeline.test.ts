import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@open-agent-harness/sdk/v2"
import {
  confirmationKey,
  protocolConfirmationRequest,
  questionConfirmationKey,
  visibleConfirmations,
} from "./session-confirmation-match"

describe("confirmation request matching", () => {
  test("matches a protocol confirmation to its question request", () => {
    const request = {
      tool: { messageID: "msg_confirm", callID: "call_confirm_plan" },
    } as Pick<QuestionRequest, "tool">

    const key = questionConfirmationKey(request)

    if (!key) throw new Error("expected confirmation key")
    expect(confirmationKey({ action_id: "confirm_plan", message_id: "msg_confirm" })).toBe(key)
  })

  test("ignores ordinary questions without a tool call", () => {
    expect(questionConfirmationKey({} as Pick<QuestionRequest, "tool">)).toBeUndefined()
  })

  test("keeps only the current pending confirmation when stale pending records remain", () => {
    const vals = visibleConfirmations(
      [
        { action_id: "confirm_old", message_id: "msg", status: "pending", updated_at: 1 },
        { action_id: "confirm_current", message_id: "msg", status: "pending", updated_at: 2 },
        { action_id: "confirm_extra", message_id: "msg", status: "pending", updated_at: 3 },
      ],
      "msg:call_confirm_current",
    )

    expect(vals.map((item) => item.action_id)).toEqual(["confirm_current"])
  })

  test("deduplicates retries for the same confirmation action", () => {
    const vals = visibleConfirmations([
      { action_id: "confirm_plan", message_id: "msg", status: "pending", updated_at: 1 },
      { action_id: "confirm_plan", message_id: "msg", status: "pending", updated_at: 2 },
    ])

    expect(vals).toHaveLength(1)
    expect(vals[0]?.updated_at).toBe(2)
  })

  test("builds a restorable question request for a pending protocol confirmation", () => {
    const req = protocolConfirmationRequest({
      sessionID: "ses_1",
      item: {
        action_id: "confirm_bridge_plan",
        message_id: "msg_1",
        plan: "Do the work.",
        run_id: "apr_1",
        status: "pending",
      },
    })

    expect(req?.id.startsWith("que_protocol_confirm_")).toBe(true)
    expect(req?.tool).toEqual({ messageID: "msg_1", callID: "call_confirm_bridge_plan" })
    expect(req?.questions[0]?.question).toContain("Do the work.")
    expect(questionConfirmationKey(req)).toBe("msg_1:call_confirm_bridge_plan")
  })
})
