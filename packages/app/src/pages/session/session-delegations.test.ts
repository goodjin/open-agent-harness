import { describe, expect, test } from "bun:test"
import type { Message } from "@open-agent-harness/sdk/v2"
import {
  delegationProgress,
  delegationSubmitted,
  laterUserInput,
  pendingDelegation,
  timelineChildren,
  timelineProgress,
  turn,
} from "./session-delegations"

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

  test("matches late assistant output by parent id", () => {
    const late = [
      { id: "user_1", role: "user" },
      { id: "user_2", role: "user" },
      { id: "assistant_1", role: "assistant", parentID: "user_1" },
    ] as Message[]

    expect(turn(late, "user_1", "assistant_1")).toBe(true)
    expect(turn(late, "user_2", "assistant_1")).toBe(false)
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

  test("detects submitted delegation runs", () => {
    const ctx = {
      protocol: {
        delegation_notified_runs: {
          run_1: 123,
        },
      },
    }

    expect(delegationSubmitted(ctx, "run_1")).toBe(true)
    expect(delegationSubmitted(ctx, "run_2")).toBe(false)
  })

  test("detects later user input after a delegation turn", () => {
    expect(laterUserInput(messages, "user_1")).toBe(true)
    expect(laterUserInput(messages, "user_2")).toBe(false)
  })

  test("reads timeline child history from user turn metadata", () => {
    const msg = {
      id: "user_1",
      sessionID: "session_1",
      role: "user",
      time: { created: 1 },
      agent: "default",
      model: { providerID: "openai", modelID: "gpt" },
      metadata: {
        turn: {
          children: [
            { id: "child_1", label: "worker", run: "run_1", current: false, status: "completed" },
            { id: "child_2", label: "review", run: "run_1", current: true, status: "pending" },
          ],
        },
      },
    } as Message

    expect(timelineChildren(msg as never)).toEqual([
      { id: "child_1", label: "worker", run: "run_1", current: false, status: "completed" },
      { id: "child_2", label: "review", run: "run_1", current: true, status: "pending" },
    ])
    expect(timelineProgress(timelineChildren(msg as never))).toEqual({
      total: 2,
      done: 1,
      active: [{ id: "child_2", label: "review", run: "run_1", current: true, status: "pending" }],
      completed: [{ id: "child_1", label: "worker", run: "run_1", current: false, status: "completed" }],
    })
  })
})
