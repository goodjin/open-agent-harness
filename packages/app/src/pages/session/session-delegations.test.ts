import { describe, expect, test } from "bun:test"
import type { Message, UserMessage } from "@open-agent-harness/sdk/v2"
import {
  delegationProgress,
  delegationStatus,
  delegationSubmitted,
  hasDelegationContext,
  hasDelegationTurn,
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

  test("keeps partial fallback delivery separate from child runtime status", () => {
    const ctx = {
      protocol: {
        completed_delegations: [
          {
            parent_message_id: "assistant_2",
            child_session_id: "child_1",
            action_title: "final_qa_check",
            status: "partial",
            satisfying: false,
            summary: "QA evidence was recovered after ActionResult validation failed.",
            notified_at: 2,
          },
        ],
      },
    }

    expect(delegationProgress(ctx, "user_1", messages).completed).toEqual([
      {
        id: "child_1",
        label: "final_qa_check",
        delivery: "partial",
        fallback: true,
        summary: "QA evidence was recovered after ActionResult validation failed.",
        notified: true,
      },
    ])
    expect(
      delegationStatus(
        delegationProgress(ctx, "user_1", messages).completed[0],
        { type: "blocked" },
      ),
    ).toBe("blocked")
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

  test("treats notified completed timeline children as history even with stale current flag", () => {
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
            {
              id: "child_1",
              label: "worker",
              run: "run_1",
              current: true,
              status: "completed",
              result_id: "result_1",
              notified_at: 2,
            },
          ],
        },
      },
    } as Message

    expect(timelineProgress(timelineChildren(msg as never))).toEqual({
      total: 1,
      done: 1,
      active: [],
      completed: [
        {
          id: "child_1",
          label: "worker",
          run: "run_1",
          current: true,
          status: "completed",
          delivery: "completed",
          completed: true,
          notified: true,
        },
      ],
    })
  })

  test("enriches timeline history with the canonical partial fallback summary", () => {
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
            {
              id: "child_1",
              label: "final_qa_check",
              current: false,
              status: "partial",
              result_id: "result_1",
              notified_at: 2,
            },
          ],
        },
      },
    } as Message
    const result = {
      id: "child_1",
      label: "final_qa_check",
      delivery: "partial",
      fallback: true,
      summary: "Recovered QA evidence.",
      notified: true,
    }

    expect(timelineProgress(timelineChildren(msg as never), [result]).completed).toEqual([
      {
        id: "child_1",
        label: "final_qa_check",
        current: false,
        status: "partial",
        delivery: "partial",
        fallback: true,
        summary: "Recovered QA evidence.",
        completed: true,
        notified: true,
      },
    ])
  })

  test("reads a partial fallback summary directly from timeline metadata", () => {
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
            {
              id: "child_1",
              label: "final_qa_check",
              current: false,
              status: "partial",
              result_id: "result_1",
              fallback: true,
              summary: "ActionResult failed validation; QA evidence was recovered.",
              notified_at: 2,
            },
          ],
        },
      },
    } as Message

    expect(timelineChildren(msg as never)).toEqual([
      {
        id: "child_1",
        label: "final_qa_check",
        current: false,
        status: "partial",
        delivery: "partial",
        fallback: true,
        summary: "ActionResult failed validation; QA evidence was recovered.",
        completed: true,
        notified: true,
      },
    ])
  })

  test("does not label an ordinary partial delivery as fallback", () => {
    const msg = {
      metadata: {
        turn: {
          children: [
            {
              id: "child_1",
              label: "partial_worker",
              status: "partial",
              result_id: "result_1",
              summary: "Partial output without fallback provenance.",
            },
          ],
        },
      },
    } as never

    expect(timelineChildren(msg)[0]).toEqual({
      id: "child_1",
      label: "partial_worker",
      status: "partial",
      delivery: "partial",
      summary: "Partial output without fallback provenance.",
      completed: true,
    })
  })

  test("uses delegation item status before falling back to idle", () => {
    expect(delegationStatus({ id: "child", label: "child", status: "terminal_reply" }, undefined)).toBe(
      "terminal_reply",
    )
    expect(delegationStatus({ id: "child", label: "child", completed: true }, undefined)).toBe("completed")
    expect(delegationStatus({ id: "child", label: "child", status: "terminal_reply" }, { type: "running" })).toBe(
      "running",
    )
    expect(delegationStatus({ id: "child", label: "child" }, undefined)).toBe("idle")
  })

  test("detects when loaded messages still miss the delegation turn", () => {
    const ctx = {
      protocol: {
        completed_delegations: [{ child_session_id: "child_1", parent_message_id: "assistant_1" }],
      },
    }
    const msg = {
      id: "user_1",
      role: "user",
      sessionID: "session_1",
      time: { created: 1 },
      agent: "default",
      model: { providerID: "openai", modelID: "gpt" },
    } as UserMessage

    expect(hasDelegationContext(ctx)).toBe(true)
    expect(hasDelegationTurn(ctx, [{ id: "user_2", role: "user" }] as Message[], [msg])).toBe(false)
    expect(hasDelegationTurn(ctx, messages, [msg])).toBe(true)
  })
})
