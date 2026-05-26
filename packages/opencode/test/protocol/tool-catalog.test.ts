import { describe, expect, test } from "bun:test"
import { ProtocolToolCatalog } from "../../src/protocol/tool-catalog"

describe("protocol tool catalog", () => {
  test("projects bash into protocol-safe language", () => {
    const text = ProtocolToolCatalog.describe({
      id: "bash",
      description: [
        "Use the Bash tool to run commands.",
        "You can make multiple Bash tool calls in a single response.",
        "Use the Read tool instead of cat.",
      ].join("\n"),
    })

    expect(text).toContain("Catalog entry only")
    expect(text).toContain("Agent Protocol DSL action")
    expect(text).toContain("native `AgentProtocolOutput` tool")
    expect(text).toContain("executor.target` to this catalog id")
    expect(text).toContain("Run a terminal command")
    expect(text).toContain("declare multiple independent protocol actions")
    expect(text).not.toContain("Bash tool calls")
    expect(text).not.toContain("Use the Read tool")
  })

  test("filters native tool-call wording from fallback descriptions", () => {
    const text = ProtocolToolCatalog.describe({
      id: "custom",
      description: [
        "Call this tool when you need custom data.",
        "Safe line to keep.",
        "Do not make tool calls manually.",
      ].join("\n"),
    })

    expect(text).toContain("Safe line to keep.")
    expect(text).not.toContain("Call this tool")
    expect(text).not.toContain("tool calls manually")
  })
})
