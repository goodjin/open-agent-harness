import { describe, expect, test } from "bun:test"
import { AgentProtocolParser } from "../../src/protocol/parser"

const block = `\`\`\`json agent-protocol
{
  "type": "agent.protocol",
  "version": "1",
  "intent": "execute",
  "execution": { "strategy": "sequential" },
  "payload": {
    "type": "action_graph",
    "actions": [
      {
        "type": "action",
        "id": "inspect",
        "title": "Inspect",
        "operation": "search",
        "executor": { "type": "tool", "target": "grep" },
        "prompt_ref": "md:inspect"
      }
    ]
  }
}
\`\`\`

## inspect

Find relevant files.`

describe("agent protocol parser", () => {
  test("parses one explicit fenced protocol block with markdown refs", () => {
    const out = AgentProtocolParser.parse(block)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.declaration.payload.type).toBe("action_graph")
    if (out.value.declaration.payload.type !== "action_graph") return
    expect(out.value.declaration.payload.actions[0]?.id).toBe("inspect")
    expect(out.value.sections.inspect?.trim()).toBe("Find relevant files.")
  })

  test("parses structured direct json and rejects multiple protocol blocks", () => {
    const out = AgentProtocolParser.parse(
      JSON.stringify({
        type: "agent.protocol.output",
        version: "1",
        intent: "respond",
        message: "Done.",
        actions: [],
      }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.declaration.message).toBe("Done.")
    expect(AgentProtocolParser.parse(`${block}\n${block}`).ok).toBe(false)
  })

  test("can recover the first protocol block from noisy output", () => {
    const out = AgentProtocolParser.first(`I will inspect.\n${block}\n<protocol-result>{}</protocol-result>\n${block}`)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.declaration.payload.type).toBe("action_graph")
    if (out.value.declaration.payload.type !== "action_graph") return
    expect(out.value.declaration.payload.actions[0]?.id).toBe("inspect")
    expect(out.value.sections.inspect).toBe("Find relevant files.")
  })
})
