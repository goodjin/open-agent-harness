import { describe, expect, test } from "bun:test"
import { AgentTemplate } from "../../src/agent/schema"
import { Policy } from "../../src/permission/policy"

function meta(input: Partial<AgentTemplate.MetaInput> = {}) {
  return AgentTemplate.Meta.parse({
    id: "agent",
    name: "Agent",
    role: "test",
    description: "test agent",
    ...input,
  })
}

describe("Policy", () => {
  test("parses allow, deny, and ask rules", () => {
    const policy = Policy.parse({
      rules: [
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*.env", action: "deny" },
        { permission: "bash", pattern: "git *", action: "ask" },
      ],
    })
    expect(policy.rules.map((rule) => rule.action)).toEqual(["allow", "deny", "ask"])
  })

  test("rejects invalid policy action", () => {
    expect(() =>
      Policy.parse({
        rules: [{ permission: "bash", pattern: "*", action: "maybe" }],
      }),
    ).toThrow()
  })

  test("converts legacy ruleset to policy and preserves behavior", () => {
    const policy = Policy.fromLegacy([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ])
    expect(Policy.evaluate(policy, "bash", "git status").action).toBe("allow")
    expect(Policy.evaluate(policy, "bash", "rm -rf /").action).toBe("deny")
  })

  test("converts agent template permission to policy", () => {
    const perm = AgentTemplate.permission(
      meta({
        permission_mode: "custom",
        allowed_tools: ["read", "bash"],
        denied_tools: ["webfetch"],
      }),
    )
    const policy = Policy.fromTemplate(perm)
    expect(Policy.evaluate(policy, "read", "file.ts").action).toBe("allow")
    expect(Policy.evaluate(policy, "bash", "ls").action).toBe("allow")
    expect(Policy.evaluate(policy, "webfetch", "https://example.com").action).toBe("deny")
    expect(Policy.evaluate(policy, "edit", "file.ts").action).toBe("deny")
  })

  test("decision trace includes matched rule and source layer", () => {
    const policy = Policy.merge(
      Policy.fromLegacy([{ permission: "*", pattern: "*", action: "ask" }], "default"),
      Policy.fromLegacy([{ permission: "bash", pattern: "*", action: "allow" }], "agent"),
    )
    const trace = Policy.evaluate(policy, "bash", "ls")
    expect(trace.action).toBe("allow")
    expect(trace.rule.source).toBe("agent")
    expect(trace.matched).toHaveLength(2)
  })

  test("disabled tool calculation uses policy output", () => {
    const policy = Policy.fromLegacy([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ])
    expect(Policy.disabled(["bash", "read"], policy)).toEqual(new Set(["read"]))
  })
})
