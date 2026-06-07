import { describe, expect, test } from "bun:test"
import { genericToolText } from "./basic-tool-detail"

describe("genericToolText", () => {
  test("renders full fallback tool details", () => {
    const text = genericToolText({
      input: {
        tool: "AgentProtocolOutput",
        error: 'Invalid input for tool AgentProtocolOutput: JSON parsing failed: Text: {"kind":',
      },
      output: "called invalid",
      metadata: {
        source: "llm",
      },
    })

    expect(text).toContain("input")
    expect(text).toContain('"tool": "AgentProtocolOutput"')
    expect(text).toContain("JSON parsing failed")
    expect(text).toContain("output\ncalled invalid")
    expect(text).toContain('"source": "llm"')
  })

  test("omits empty sections", () => {
    expect(genericToolText({ input: {}, metadata: {} })).toBe("")
  })
})
