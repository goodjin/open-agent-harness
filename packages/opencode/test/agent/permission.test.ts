import { describe, expect, test } from "bun:test"
import { AgentTemplate } from "../../src/agent/schema"
import { buildPermission, buildPolicy } from "../../src/agent/permission"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

function meta(input: Partial<AgentTemplate.MetaInput> = {}) {
  return AgentTemplate.Meta.parse({
    id: "agent",
    name: "Agent",
    role: "test",
    description: "test agent",
    ...input,
  })
}

describe("buildPermission", () => {
  test("buildPolicy preserves default, user, and agent sources", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: "allow",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const policy = await buildPolicy(
          meta({
            permission_mode: "custom",
            inherit_permissions: true,
            allowed_tools: ["read"],
          }),
        )
        const sources = new Set(policy.rules.map((rule) => rule.source))
        expect(sources.has("default")).toBe(true)
        expect(sources.has("user")).toBe(true)
        expect(sources.has("agent")).toBe(true)
      },
    })
  })

  test("default mode does not inherit config permissions", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: "deny",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = await buildPermission(meta({ permission_mode: "lax" }))
        expect(PermissionNext.evaluate("bash", "ls", rules).action).toBe("allow")
      },
    })
  })

  test("strict mode inherits config and preserves explicit user denies", async () => {
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
        const rules = await buildPermission(meta({ inherit_permissions: true, permission_mode: "strict" }))
        expect(PermissionNext.evaluate("read", "file.ts", rules).action).toBe("allow")
        expect(PermissionNext.evaluate("bash", "ls", rules).action).toBe("deny")
      },
    })
  })

  test("lax mode allows by default without overriding explicit user denies", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: "deny",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = await buildPermission(meta({ inherit_permissions: true, permission_mode: "lax" }))
        expect(PermissionNext.evaluate("read", "file.ts", rules).action).toBe("allow")
        expect(PermissionNext.evaluate("edit", "file.ts", rules).action).toBe("allow")
        expect(PermissionNext.evaluate("bash", "ls", rules).action).toBe("deny")
      },
    })
  })

  test("lax mode does not override core ask or deny rules", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = await buildPermission(meta({ inherit_permissions: true, permission_mode: "lax" }))
        expect(PermissionNext.evaluate("question", "*", rules).action).toBe("deny")
        expect(PermissionNext.evaluate("plan_enter", "*", rules).action).toBe("deny")
        expect(PermissionNext.evaluate("doom_loop", "*", rules).action).toBe("ask")
      },
    })
  })

  test("lax mode preserves user ask and deny rules", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          question: "ask",
          plan_enter: "deny",
          doom_loop: "deny",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = await buildPermission(meta({ inherit_permissions: true, permission_mode: "lax" }))
        expect(PermissionNext.evaluate("question", "*", rules).action).toBe("ask")
        expect(PermissionNext.evaluate("plan_enter", "*", rules).action).toBe("deny")
        expect(PermissionNext.evaluate("doom_loop", "*", rules).action).toBe("deny")
      },
    })
  })

  test("custom mode limits tools to allowed_tools", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: "allow",
          edit: "allow",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = await buildPermission(
          meta({
            permission_mode: "custom",
            allowed_tools: ["read"],
          }),
        )
        expect(PermissionNext.evaluate("read", "file.ts", rules).action).toBe("allow")
        expect(PermissionNext.evaluate("bash", "ls", rules).action).not.toBe("allow")
        expect(PermissionNext.evaluate("edit", "file.ts", rules).action).not.toBe("allow")
        expect(PermissionNext.disabled(["bash", "edit"], rules)).toEqual(new Set(["bash", "edit"]))
      },
    })
  })

  test("custom denied_tools override allowed_tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = await buildPermission(
          meta({
            permission_mode: "custom",
            allowed_tools: ["read", "bash"],
            denied_tools: ["bash"],
          }),
        )
        expect(PermissionNext.evaluate("read", "file.ts", rules).action).toBe("allow")
        expect(PermissionNext.evaluate("bash", "ls", rules).action).toBe("deny")
      },
    })
  })
})
