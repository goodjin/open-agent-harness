import { describe, expect, test } from "bun:test"
import { protocolMeta, protocolText } from "./message-part-protocol"

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
