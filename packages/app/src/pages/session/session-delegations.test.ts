import { describe, expect, test } from "bun:test"
import type { Message } from "@open-agent-harness/sdk/v2"
import { delegationProgress, pendingDelegation, turn } from "./session-delegations"

const messages = [
  { id: "user_1", role: "user" },
  { id: "assistant_1", role: "assistant", parentID: "user_1" },
  { id: "assistant_2", role: "assistant", parentID: "user_1" },
  { id: "user_2", role: "user" },
] as Message[]

describe("session delegations", () => {
  test("matches assistant protocol output to its user turn", () => {
    expect(turn(messages, "user_1", "assistant_2")).toBe(true)
    expect(turn(messages, "user_2", "assistant_2")).toBe(false)
  })

  test("counts child sessions created by assistant messages in the turn", () => {
    const ctx = {
      protocol: {
        completed_delegations: [
          {
            parent_message_id: "assistant_2",
            child_session_id: "child_1",
            action_title: "explore_context",
          },
        ],
      },
    }

    expect(delegationProgress(ctx, "user_1", messages)).toEqual({
      total: 1,
      done: 1,
      active: [],
      completed: [{ id: "child_1", label: "explore_context" }],
    })
  })

  test("detects pending child sessions created by assistant messages in the turn", () => {
    const ctx = {
      protocol: {
        pending_delegations: {
          task: {
            parent_message_id: "assistant_1",
            child_session_id: "child_2",
          },
        },
      },
    }

    expect(pendingDelegation(ctx, "user_1", messages)).toBe(true)
  })

  test("keeps run id on child session rows", () => {
    const ctx = {
      protocol: {
        pending_delegations: {
          task: {
            parent_message_id: "assistant_1",
            child_session_id: "child_2",
            action_title: "run child",
            run_id: "run_1",
          },
        },
      },
    }

    expect(delegationProgress(ctx, "user_1", messages).active).toEqual([
      { id: "child_2", label: "run child", run: "run_1" },
    ])
  })
})
