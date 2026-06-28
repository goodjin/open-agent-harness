import { describe, expect, test } from "bun:test"
import { agentDelegable, agentHidden, agentLabel, agentMentionable, agentPrimary, agentVisible } from "./agent"

describe("agent entry helpers", () => {
  test("keeps legacy mode semantics when entry is absent", () => {
    expect(agentPrimary({ mode: "all" })).toBe(true)
    expect(agentPrimary({ mode: "primary" })).toBe(true)
    expect(agentPrimary({ mode: "subagent" })).toBe(false)
    expect(agentVisible({ mode: "subagent" })).toBe(true)
    expect(agentMentionable({ mode: "primary" })).toBe(false)
    expect(agentMentionable({ mode: "subagent" })).toBe(true)
    expect(agentDelegable({ mode: "all" })).toBe(true)
  })

  test("uses explicit entry flags for new agent metadata", () => {
    const item = {
      mode: "subagent" as const,
      entry: {
        primary: true,
        mentionable: false,
        delegable: true,
      },
    }

    expect(agentPrimary(item)).toBe(true)
    expect(agentMentionable(item)).toBe(false)
    expect(agentDelegable(item)).toBe(true)
  })

  test("hides agents from all entry lists", () => {
    const item = {
      mode: "all" as const,
      entry: {
        primary: true,
        mentionable: true,
        delegable: true,
        hidden: true,
      },
    }

    expect(agentHidden(item)).toBe(true)
    expect(agentPrimary(item)).toBe(false)
    expect(agentMentionable(item)).toBe(false)
    expect(agentDelegable(item)).toBe(false)
  })

  test("formats identity and persona labels", () => {
    expect(agentLabel({ name: "backend", displayName: "Backend Worker", identityName: "后端开发", personaName: "沈越" })).toBe(
      "后端开发-沈越",
    )
    expect(agentLabel({ name: "backend", displayName: "Backend Worker" })).toBe("Backend Worker")
    expect(agentLabel({ name: "backend" })).toBe("backend")
  })
})
