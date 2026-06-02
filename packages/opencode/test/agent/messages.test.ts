import { describe, expect, test } from "bun:test"
import { resolveMessages } from "../../src/agent/messages"

describe("resolveMessages", () => {
  test("returns runtime records for matching event triggers", () => {
    const got = resolveMessages({
      event: "before_model_call",
      meta: {
        instructions: {
          model_messages: [
            {
              on: "before_model_call",
              position: "prefix",
              content: "Keep the answer short.",
            },
            {
              on: "after_tool_result",
              position: "suffix",
              content: "Summarize tool evidence.",
            },
            {
              on: "before_model_call",
              position: "observation",
              content: "Runtime observation.",
            },
          ],
        },
      },
    })

    expect(got.diagnostics).toEqual([])
    expect(got.records).toEqual([
      {
        author: "runtime",
        trigger: "before_model_call",
        position: "prefix",
        content: "Keep the answer short.",
        source: {
          kind: "agent.metadata.instructions.model_messages",
          index: 0,
        },
      },
      {
        author: "runtime",
        trigger: "before_model_call",
        position: "observation",
        content: "Runtime observation.",
        source: {
          kind: "agent.metadata.instructions.model_messages",
          index: 2,
        },
      },
    ])
  })

  test("ignores unsupported triggers without diagnostics", () => {
    const got = resolveMessages({
      event: "before_model_call",
      meta: {
        instructions: {
          model_messages: [
            {
              on: "start",
              position: "prefix",
              content: "Not for this event.",
            },
          ],
        },
      },
    })

    expect(got.records).toEqual([])
    expect(got.diagnostics).toEqual([])
  })

  test("skips unsupported positions with deterministic diagnostics", () => {
    const got = resolveMessages({
      event: "start",
      meta: {
        instructions: {
          model_messages: [
            {
              on: "start",
              position: "append",
              content: "Unsupported insertion point.",
            },
          ],
        },
      },
    })

    expect(got.records).toEqual([])
    expect(got.diagnostics).toEqual([
      {
        level: "warning",
        code: "unsupported_position",
        field: "instructions.model_messages.0.position",
        message: "Unsupported model message position: append",
      },
    ])
  })

  test("skips empty content with diagnostics", () => {
    const got = resolveMessages({
      event: "start",
      meta: {
        instructions: {
          model_messages: [
            {
              on: "start",
              position: "suffix",
              content: "   ",
            },
          ],
        },
      },
    })

    expect(got.records).toEqual([])
    expect(got.diagnostics).toEqual([
      {
        level: "warning",
        code: "empty_content",
        field: "instructions.model_messages.0.content",
        message: "Model message content is empty",
      },
    ])
  })

  test("sorts by priority and truncates with budget diagnostics", () => {
    const got = resolveMessages({
      event: "start",
      budget: {
        maxMessages: 2,
        maxChars: 8,
      },
      meta: {
        instructions: {
          model_messages: [
            {
              on: "start",
              position: "prefix",
              content: "third",
              priority: 1,
            },
            {
              on: "start",
              position: "prefix",
              content: "first",
              priority: 10,
            },
            {
              on: "start",
              position: "prefix",
              content: "second",
              priority: 5,
            },
          ],
        },
      },
    })

    expect(got.records.map((item) => item.content)).toEqual(["first"])
    expect(got.diagnostics).toEqual([
      {
        level: "warning",
        code: "budget_exceeded",
        field: "instructions.model_messages.2.content",
        message: "Model message budget exceeded",
      },
      {
        level: "warning",
        code: "budget_exceeded",
        field: "instructions.model_messages.0.content",
        message: "Model message budget exceeded",
      },
    ])
  })
})
