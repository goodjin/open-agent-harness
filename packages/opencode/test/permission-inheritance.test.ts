import { describe, test, expect } from "bun:test"
import { PermissionNext } from "../src/permission/next"
import { Session } from "../src/session"
import { Config } from "../src/config/config"
import { Instance } from "../src/project/instance"
import { WorkspaceContext } from "../src/control-plane/workspace-context"
import { WorkspaceID } from "../src/control-plane/schema"
import { tmpdir } from "./fixture/fixture"

describe("PermissionNext.merge", () => {
  test("merges multiple rulesets preserving order", () => {
    const ruleset1 = [
      { permission: "read", pattern: "*.ts", action: "allow" as const },
      { permission: "edit", pattern: "*.ts", action: "deny" as const },
    ]
    const ruleset2 = [
      { permission: "read", pattern: "*.js", action: "allow" as const },
      { permission: "bash", pattern: "*", action: "ask" as const },
    ]
    const merged = PermissionNext.merge(ruleset1, ruleset2)
    expect(merged).toHaveLength(4)
    expect(merged[0]).toEqual({ permission: "read", pattern: "*.ts", action: "allow" })
    expect(merged[1]).toEqual({ permission: "edit", pattern: "*.ts", action: "deny" })
    expect(merged[2]).toEqual({ permission: "read", pattern: "*.js", action: "allow" })
    expect(merged[3]).toEqual({ permission: "bash", pattern: "*", action: "ask" })
  })

  test("handles empty rulesets", () => {
    const merged = PermissionNext.merge([], [])
    expect(merged).toHaveLength(0)
  })

  test("handles single ruleset", () => {
    const ruleset = [{ permission: "read", pattern: "*", action: "allow" as const }]
    const merged = PermissionNext.merge(ruleset)
    expect(merged).toEqual(ruleset)
  })
})

describe("VAL-PERM-010: Permission inheritance - session inherits agent permission", () => {
  test("session permission is empty when created without permission parameter", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          read: "allow",
          bash: "deny",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: "test-workspace" as WorkspaceID,
          fn: async () => {
            const session = await Session.create({ title: "Test session" })
            // Session created without explicit permission - should be undefined initially
            expect(session.permission).toBeUndefined()
          },
        })
      },
    })
  })

  test("PermissionNext.fromConfig creates rules from permission config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          read: "allow",
          bash: "deny",
          task: {
            "*": "allow",
            "code-reviewer": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        const ruleset = PermissionNext.fromConfig(cfg.permission ?? {})
        expect(ruleset.length).toBeGreaterThan(0)

        // Agent should have the task permission rules
        const taskRules = ruleset.filter((r) => r.permission === "task")
        expect(taskRules.length).toBeGreaterThan(0)

        // Verify the task rules work correctly
        expect(PermissionNext.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
      },
    })
  })
})

describe("VAL-PERM-011: Permission inheritance - child agent inherits from parent task", () => {
  test("merge combines taskAgent.permission and session.permission", async () => {
    const taskAgentPerm = [
      { permission: "read", pattern: "*", action: "allow" as const },
      { permission: "edit", pattern: "*.ts", action: "allow" as const },
    ]
    const sessionPerm = [
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "read", pattern: "*.json", action: "deny" as const },
    ]
    const merged = PermissionNext.merge(taskAgentPerm, sessionPerm)
    expect(merged).toHaveLength(4)
    // First ruleset rules come first
    expect(merged[0]).toEqual({ permission: "read", pattern: "*", action: "allow" })
    expect(merged[1]).toEqual({ permission: "edit", pattern: "*.ts", action: "allow" })
    // Then second ruleset rules
    expect(merged[2]).toEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(merged[3]).toEqual({ permission: "read", pattern: "*.json", action: "deny" })
  })

  test("last match wins in merged ruleset for same permission/pattern", async () => {
    const taskAgentPerm = [
      { permission: "read", pattern: "*.ts", action: "allow" as const },
    ]
    const sessionPerm = [
      { permission: "read", pattern: "*.ts", action: "deny" as const },
    ]
    const merged = PermissionNext.merge(taskAgentPerm, sessionPerm)
    // session permission comes last, so it should win
    const result = PermissionNext.evaluate("read", "file.ts", merged)
    expect(result.action).toBe("deny")
  })

  test("merged ruleset - session deny wins for orchestrator agents (last match wins)", async () => {
    const taskAgentPerm = [
      { permission: "task", pattern: "code-reviewer", action: "deny" as const },
      { permission: "task", pattern: "*", action: "allow" as const },
    ]
    const sessionPerm = [
      { permission: "task", pattern: "orchestrator-*", action: "deny" as const },
    ]
    const merged = PermissionNext.merge(taskAgentPerm, sessionPerm)
    // orchestrator-fast should be denied by session rule (session rules come last, last match wins)
    expect(PermissionNext.evaluate("task", "orchestrator-fast", merged).action).toBe("deny")
    // general should be allowed by task agent wildcard (no session rule overrides)
    expect(PermissionNext.evaluate("task", "general", merged).action).toBe("allow")
  })
})

describe("Permission inheritance integration with real permission config", () => {
  test("PermissionNext.fromConfig creates proper ruleset from permission config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          read: "allow",
          edit: {
            "*.ts": "allow",
            "*.md": "deny",
          },
          bash: "ask",
          task: {
            "*": "ask",
            "general": "allow",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        const ruleset = PermissionNext.fromConfig(cfg.permission ?? {})
        expect(ruleset.length).toBeGreaterThan(0)

        // Verify task permission behavior
        const generalResult = PermissionNext.evaluate("task", "general", ruleset)
        expect(generalResult.action).toBe("allow")

        // Other agents should ask (default)
        const otherResult = PermissionNext.evaluate("task", "other-agent", ruleset)
        expect(otherResult.action).toBe("ask")
      },
    })
  })
})
