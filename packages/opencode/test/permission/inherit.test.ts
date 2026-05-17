import { describe, expect, test } from "bun:test"
import { PermissionInherit } from "../../src/permission/inherit"
import { Policy } from "../../src/permission/policy"

describe("PermissionInherit", () => {
  test("calculates user, project, session, agent, and tool layers in order", () => {
    const policy = PermissionInherit.calculate(
      [
        { source: "tool", policy: Policy.fromLegacy([{ permission: "bash", pattern: "git *", action: "allow" }]) },
        { source: "user", policy: Policy.fromLegacy([{ permission: "*", pattern: "*", action: "ask" }]) },
        { source: "agent", policy: Policy.fromLegacy([{ permission: "bash", pattern: "*", action: "allow" }]) },
        { source: "project", policy: Policy.fromLegacy([{ permission: "edit", pattern: "*", action: "ask" }]) },
        { source: "session", policy: Policy.fromLegacy([{ permission: "read", pattern: "*", action: "allow" }]) },
      ],
      { deny: false },
    )
    expect(policy.rules.map((rule) => rule.source)).toEqual(["user", "project", "session", "agent", "tool"])
    expect(Policy.evaluate(policy, "bash", "git status").rule.source).toBe("tool")
  })

  test("last match wins when explicit deny hoisting is disabled", () => {
    const policy = PermissionInherit.calculate(
      [
        { source: "user", policy: Policy.fromLegacy([{ permission: "bash", pattern: "*", action: "deny" }]) },
        { source: "agent", policy: Policy.fromLegacy([{ permission: "bash", pattern: "*", action: "allow" }]) },
      ],
      { deny: false },
    )
    expect(Policy.evaluate(policy, "bash", "ls").action).toBe("allow")
  })

  test("explicit deny takes precedence by default", () => {
    const policy = PermissionInherit.calculate([
      { source: "user", policy: Policy.fromLegacy([{ permission: "bash", pattern: "*", action: "deny" }]) },
      { source: "agent", policy: Policy.fromLegacy([{ permission: "bash", pattern: "*", action: "allow" }]) },
    ])
    expect(Policy.evaluate(policy, "bash", "ls").action).toBe("deny")
    expect(Policy.evaluate(policy, "bash", "ls").rule.source).toBe("user")
  })
})
