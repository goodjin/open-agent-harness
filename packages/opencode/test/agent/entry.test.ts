import { describe, expect, test } from "bun:test"
import { AgentEntry } from "../../src/agent/entry"

describe("agent entry selection", () => {
  test("uses entry flags before legacy mode", () => {
    const agent = {
      mode: "subagent" as const,
      hidden: false,
      entry: {
        primary: true,
        delegable: false,
        mentionable: false,
        hidden: false,
      },
    }

    expect(AgentEntry.primary(agent)).toBe(true)
    expect(AgentEntry.delegable(agent)).toBe(false)
    expect(AgentEntry.mentionable(agent)).toBe(false)
  })

  test("keeps legacy mode fallbacks per surface", () => {
    expect(AgentEntry.primary({ mode: "primary" })).toBe(true)
    expect(AgentEntry.primary({ mode: "subagent" })).toBe(false)
    expect(AgentEntry.delegable({ mode: "subagent" })).toBe(true)
    expect(AgentEntry.delegable({ mode: "primary" })).toBe(false)
    expect(AgentEntry.mentionable({ mode: "all" })).toBe(true)
    expect(AgentEntry.mentionable({ mode: "primary" })).toBe(false)
  })

  test("hides agents on top-level or entry hidden flags", () => {
    expect(AgentEntry.primary({ mode: "all", hidden: true })).toBe(false)
    expect(AgentEntry.primary({ mode: "all", hidden: true, entry: { primary: true, hidden: false } })).toBe(false)
    expect(AgentEntry.delegable({ mode: "subagent", entry: { delegable: true, hidden: true } })).toBe(false)
  })
})
