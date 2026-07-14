import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionTurn } from "../../src/session/turn"

const sessionID = "ses_test"

function user(input: { id: string; turn?: SessionTurn.Info }) {
  return {
    info: {
      id: input.id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      metadata: input.turn ? { turn: input.turn } : undefined,
    } as MessageV2.User,
    parts: [],
  } satisfies MessageV2.WithParts
}

function assistant(input: { id: string; parentID: string; completed?: number; error?: boolean; finish?: string }) {
  return {
    info: {
      id: input.id,
      sessionID,
      role: "assistant",
      parentID: input.parentID,
      mode: "build",
      agent: "build",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      path: { cwd: "/tmp", root: "/tmp" },
      finish: input.finish,
      error: input.error
        ? new MessageV2.APIError({ message: "failed", isRetryable: false }).toObject()
        : undefined,
      time: { created: 2, completed: input.completed },
    } as MessageV2.Assistant,
    parts: [],
  } satisfies MessageV2.WithParts
}

describe("SessionTurn.fallback", () => {
  test("treats legacy errored completed assistants as handled", () => {
    const msg = user({ id: "u1" })

    expect(
      SessionTurn.fallback({
        messages: [msg, assistant({ id: "a1", parentID: "u1", completed: 3, error: true })],
        user: msg.info,
      }),
    ).toBe(true)
  })

  test("does not skip explicit running turns after tool-call assistant completion", () => {
    const msg = user({
      id: "u1",
      turn: {
        kind: "user",
        status: "running",
        time: { queued: 1, started: 2 },
      },
    })

    expect(
      SessionTurn.fallback({
        messages: [msg, assistant({ id: "a1", parentID: "u1", completed: 3, finish: "tool-calls" })],
        user: msg.info,
      }),
    ).toBe(false)
  })
})

describe("SessionTurn.next", () => {
  test("selects queued turns in persisted FIFO order regardless of kind", () => {
    const internal = user({
      id: "u1",
      turn: {
        kind: "internal",
        status: "queued",
        time: { queued: 1 },
      },
    })
    const regular = user({
      id: "u2",
      turn: {
        kind: "user",
        status: "queued",
        time: { queued: 2 },
      },
    })

    expect(String(SessionTurn.next([regular, internal])?.info.id)).toBe("u1")
  })

  test("ignores running and completed turns", () => {
    const running = user({
      id: "u1",
      turn: {
        kind: "user",
        status: "running",
        time: { queued: 1, started: 2 },
      },
    })
    const done = user({
      id: "u2",
      turn: {
        kind: "user",
        status: "done",
        outcome: "completed",
        reason: "assistant",
        time: { queued: 2, started: 3, completed: 4 },
      },
    })

    expect(SessionTurn.next([running, done])).toBeUndefined()
  })
})
