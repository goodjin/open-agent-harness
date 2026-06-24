import { describe, expect, test } from "bun:test"
import { actionResult, invalidProtocol, protocolMeta, protocolText } from "./message-part-protocol"

describe("protocolText", () => {
  test("renders flat AgentProtocolOutput input", () => {
    const text = protocolText({
      input: {
        kind: "act",
        message: "Run work",
        calls: [{ id: "inspect", type: "agent", name: "frontend", args: { prompt: "Inspect UI" } }],
      },
    })

    expect(text).toContain('"kind": "act"')
    expect(text).toContain('"message": "Run work"')
    expect(text).toContain('"prompt": "Inspect UI"')
  })

  test("unwraps stringified input payloads", () => {
    const text = protocolText({
      input: {
        input: JSON.stringify({ kind: "answer", message: "Done" }),
      },
    })

    expect(text).toContain('"kind": "answer"')
    expect(text).toContain('"message": "Done"')
  })

  test("falls back to metadata raw when input is empty", () => {
    const text = protocolText({
      input: {},
      metadata: {
        raw: { kind: "act", message: "Recovered", calls: [] },
      },
    })

    expect(text).toContain('"message": "Recovered"')
  })
})

describe("protocolMeta", () => {
  test("reads kind and call count", () => {
    expect(protocolMeta({ kind: "act", calls: [{ id: "one" }, { id: "two" }] })).toEqual({
      kind: "act",
      calls: "2",
    })
  })
})

describe("invalidProtocol", () => {
  test("shows parse failure and captured raw output", () => {
    expect(
      invalidProtocol({
        input: {
          tool: "AgentProtocolOutput",
          error: "Invalid input for tool AgentProtocolOutput",
          raw: '{"version": "2", "items":',
        },
      }),
    ).toEqual({
      type: "解析输出失败",
      output: '{"version": "2", "items":',
    })
  })

  test("falls back to raw protocol output in rendered text", () => {
    expect(
      invalidProtocol({
        input: {
          tool: "AgentProtocolOutput",
          error: "Invalid input for tool AgentProtocolOutput",
        },
        output: 'Invalid input\n\nRaw protocol output:\n{"version": "2", "items":',
      }),
    ).toEqual({
      type: "解析输出失败",
      output: '{"version": "2", "items":',
    })
  })

  test("ignores non-protocol invalid tool calls", () => {
    expect(invalidProtocol({ input: { tool: "bash", raw: "x" } })).toBeUndefined()
  })
})

describe("actionResult", () => {
  test("shows parse failure and captured raw input", () => {
    expect(
      actionResult({
        tool: "ActionResult",
        input: {},
        metadata: {
          rawInput: '{"action_id":"feature","status":"success"}',
        },
      }),
    ).toEqual({
      type: "解析结果失败",
      output: '{"action_id":"feature","status":"success"}',
    })
  })

  test("falls back to parsed input", () => {
    expect(
      actionResult({
        tool: "ActionResult",
        input: {},
        metadata: {},
      }),
    ).toEqual({
      type: "解析结果失败",
      output: "{}",
    })
  })

  test("ignores other tools", () => {
    expect(actionResult({ tool: "bash", input: {} })).toBeUndefined()
  })
})
