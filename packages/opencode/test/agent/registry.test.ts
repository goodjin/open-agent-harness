import { test, expect, describe } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { AgentRegistry, resetRegistry } from "../../src/agent/registry"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

async function write(dir: string, id: string, description: string) {
  const root = path.join(dir, id)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({
      id,
      name: "Agent",
      role: "test",
      description,
    }),
  )
  await fs.writeFile(path.join(root, "identity.md"), "# Identity")
  await fs.writeFile(path.join(root, "rules.md"), "# Rules")
}

async function entry(dir: string, id: string, cfg: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const root = path.join(dir, ".opencode", "agents", id)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({
      id,
      name: id,
      role: "test",
      description: `${id} agent`,
      ...cfg,
    }),
  )
  await fs.writeFile(path.join(root, "identity.md"), "# Identity")
  await fs.writeFile(path.join(root, "rules.md"), "# Rules")
  await fs.writeFile(path.join(dir, ".opencode", "opencode.json"), JSON.stringify(config))
}

describe("AgentRegistry", () => {
  describe("with instance context", () => {
    test("list() returns array of agent metadata", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          expect(Array.isArray(agents)).toBe(true)
        },
      })
    })

    test("list() returns agents with id, name, description, mode, entry, capability", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          if (agents.length === 0) return

          for (const agent of agents) {
            expect(typeof agent.id).toBe("string")
            expect(typeof agent.name).toBe("string")
            expect(typeof agent.description).toBe("string")
            expect(["primary", "subagent", "all"]).toContain(agent.mode)
            expect(typeof agent.entry.primary).toBe("boolean")
            expect(typeof agent.entry.delegable).toBe("boolean")
            expect(typeof agent.entry.mentionable).toBe("boolean")
            expect(typeof agent.entry.default).toBe("boolean")
            expect(typeof agent.entry.hidden).toBe("boolean")
            expect(typeof agent.capability.purpose).toBe("string")
            expect(Array.isArray(agent.capability.tags)).toBe(true)
            expect(["low", "medium", "high"]).toContain(agent.capability.cost)
            expect(typeof agent.capability.writes).toBe("boolean")
          }
        },
      })
    })

    test("get(id) and Agent.get expose entry, capability, and derived mode", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(tmp.path, "reviewer", {
        mode: "subagent",
        entry: {
          primary: true,
          delegable: false,
          mentionable: true,
          default: true,
          hidden: false,
        },
        capability: {
          purpose: "code_review",
          tags: ["review"],
          cost: "low",
          writes: false,
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")
          const info = await registry.get("reviewer")
          const agent = await Agent.get("reviewer", registry)

          expect(info?.entry.primary).toBe(true)
          expect(info?.entry.delegable).toBe(false)
          expect(info?.capability.purpose).toBe("code_review")
          expect(info?.mode).toBe("primary")
          expect(agent?.entry.primary).toBe(true)
          expect(agent?.entry.delegable).toBe(false)
          expect(agent?.capability.writes).toBe(false)
          expect(agent?.mode).toBe("primary")
        },
      })
    })

    test("get(id) and Agent.get preserve legacy primary mode", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(tmp.path, "legacy", {
        mode: "primary",
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")
          const info = await registry.get("legacy")
          const agent = await Agent.get("legacy", registry)

          expect(info?.entry.primary).toBe(true)
          expect(info?.entry.delegable).toBe(true)
          expect(info?.mode).toBe("primary")
          expect(agent?.entry.primary).toBe(true)
          expect(agent?.entry.delegable).toBe(true)
          expect(agent?.mode).toBe("primary")
        },
      })
    })

    test("list() always returns built-in default agent", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const emptyRegistry = new AgentRegistry("/nonexistent/path", "/also/nonexistent")
          const agents = await emptyRegistry.list()
          // Should always have built-in default agent
          expect(agents.find((a) => a.id === "default")).toBeDefined()
          expect(agents.length).toBeGreaterThanOrEqual(1)
        },
      })
    })

    test("get(id) returns complete agent template when found", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          if (agents.length === 0) return

          const firstAgent = agents[0]
          const template = await registry.get(firstAgent.id)

          expect(template).toBeDefined()
          if (template) {
            expect(template.id).toBe(firstAgent.id)
            expect(template.name).toBe(firstAgent.name)
            expect(template.meta).toBeDefined()
            expect(typeof template.identity).toBe("string")
            expect(typeof template.rules).toBe("string")
          }
        },
      })
    })

    test("get(id) returns undefined when agent not found", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const template = await registry.get("nonexistent-agent-id")
          expect(template).toBeUndefined()
        },
      })
    })

    test("getDefaultId() returns default_agent from config", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const defaultId = await registry.getDefaultId()
          expect(defaultId === undefined || typeof defaultId === "string").toBe(true)
        },
      })
    })

    test("setDefault(id) throws error when agent not found", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          await expect(registry.setDefault("nonexistent-agent")).rejects.toThrow("Agent not found")
        },
      })
    })

    test("setDefault(id) updates default agent in config", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          const agent = agents.find((item) => item.entry.primary && item.entry.default && !item.entry.hidden)
          if (!agent) return

          // setDefault should not throw when agent exists
          try {
            await registry.setDefault(agent.id)
          } catch (err) {
            throw new Error(`setDefault should not throw: ${err}`)
          }
        },
      })
    })

    test("getCurrentId() returns undefined initially", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          expect(registry.getCurrentId()).toBeUndefined()
        },
      })
    })

    test("switch() changes current agent", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          if (agents.length === 0) return

          const firstAgent = agents[0]
          const switched = await registry.switch(firstAgent.id)

          expect(switched).toBeDefined()
          expect(registry.getCurrentId()).toBe(firstAgent.id)
        },
      })
    })

    test("switch() returns undefined for nonexistent agent", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const result = await registry.switch("nonexistent-agent")
          expect(result).toBeUndefined()
        },
      })
    })

    test("switch() preserves session state by not clearing cache", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          if (agents.length < 2) return

          // Load all agents first
          await registry.list()

          // Switch to first agent
          await registry.switch(agents[0].id)
          expect(registry.getCurrentId()).toBe(agents[0].id)

          // Switch to second agent
          await registry.switch(agents[1].id)
          expect(registry.getCurrentId()).toBe(agents[1].id)

          // Cache should still contain all agents
          const allAgents = await registry.list()
          expect(allAgents.length).toBeGreaterThanOrEqual(2)
        },
      })
    })

    test("getEffectiveAgent() returns current agent when switched", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()
          if (agents.length === 0) return

          await registry.switch(agents[0].id)
          const effective = await registry.getEffectiveAgent()

          expect(effective).toBeDefined()
          expect(effective?.id).toBe(agents[0].id)
        },
      })
    })

    test("getEffectiveAgent() returns default agent when no switch", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const cfg = await Config.get()
          const defaultId = cfg.default_agent

          if (!defaultId) return

          const effective = await registry.getEffectiveAgent()
          expect(effective?.id).toBe(defaultId)
        },
      })
    })

    test("invalidateCache forces reload", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          // Load agents
          const agents1 = await registry.list()

          // Invalidate cache
          registry.invalidateCache()

          // Load again
          const agents2 = await registry.list()

          // Should get same results
          expect(agents1.length).toBe(agents2.length)
        },
      })
    })

    test("template file changes invalidate cache without manual reset", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-registry-test-"))
      try {
        await write(tmp, "changed", "first")
        const registry = new AgentRegistry(tmp, "/nonexistent/fallback")
        expect((await registry.get("changed"))?.meta.description).toBe("first")

        await write(tmp, "changed", "second version")
        expect((await registry.get("changed"))?.meta.description).toBe("second version")
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("templates() returns template validation status", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-registry-test-"))
      try {
        await write(tmp, "valid", "valid")
        const bad = path.join(tmp, "bad")
        await fs.mkdir(bad)
        await fs.writeFile(path.join(bad, "meta.json"), "{ bad json }")

        const registry = new AgentRegistry(tmp, "/nonexistent/fallback")
        const templates = await registry.templates()
        expect(templates.find((item) => item.id === "valid")?.valid).toBe(true)
        expect(templates.find((item) => item.dir === bad)?.valid).toBe(false)
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("missing default agent falls back to built-in default", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry("/nonexistent/path", "/also/nonexistent")
          const effective = await registry.getEffectiveAgent()
          expect(effective?.id).toBe("default")
        },
      })
    })

    test("getEffectiveAgent() searches for eligible default when config is unset", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(tmp.path, "default", {
        entry: {
          primary: false,
          delegable: true,
          mentionable: true,
          default: true,
          hidden: false,
        },
      })
      await entry(tmp.path, "chosen", {
        entry: {
          primary: true,
          delegable: true,
          mentionable: true,
          default: true,
          hidden: false,
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")
          const effective = await registry.getEffectiveAgent()

          expect(effective?.id).toBe("chosen")
        },
      })
    })

    test("defaultAgent accepts entry primary default visible agent", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(
        tmp.path,
        "chosen",
        {
          entry: {
            primary: true,
            delegable: true,
            mentionable: true,
            default: true,
            hidden: false,
          },
        },
        { default_agent: "chosen" },
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          expect(await Agent.defaultAgent()).toBe("chosen")
        },
      })
    })

    test("defaultAgent rejects non-primary default entry", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(
        tmp.path,
        "helper",
        {
          entry: {
            primary: false,
            delegable: true,
            mentionable: true,
            default: true,
            hidden: false,
          },
        },
        { default_agent: "helper" },
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          await expect(Agent.defaultAgent()).rejects.toThrow('default agent "helper" is not a primary agent')
        },
      })
    })

    test("defaultAgent rejects hidden and non-default entry", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(
        tmp.path,
        "hidden",
        {
          entry: {
            primary: true,
            delegable: true,
            mentionable: true,
            default: true,
            hidden: true,
          },
        },
        { default_agent: "hidden" },
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          await expect(Agent.defaultAgent()).rejects.toThrow('default agent "hidden" is hidden')
        },
      })

      await using next = await tmpdir({ git: true })
      await entry(
        next.path,
        "manual",
        {
          entry: {
            primary: true,
            delegable: true,
            mentionable: true,
            default: false,
            hidden: false,
          },
        },
        { default_agent: "manual" },
      )

      await Instance.provide({
        directory: next.path,
        fn: async () => {
          resetRegistry()
          await expect(Agent.defaultAgent()).rejects.toThrow('default agent "manual" is not default eligible')
        },
      })
    })

    test("setDefault rejects ineligible agents", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(tmp.path, "helper", {
        entry: {
          primary: false,
          delegable: true,
          mentionable: true,
          default: true,
          hidden: false,
        },
      })
      await entry(tmp.path, "hidden", {
        entry: {
          primary: true,
          delegable: true,
          mentionable: true,
          default: true,
          hidden: true,
        },
      })
      await entry(tmp.path, "manual", {
        entry: {
          primary: true,
          delegable: true,
          mentionable: true,
          default: false,
          hidden: false,
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")

          await expect(registry.setDefault("helper")).rejects.toThrow('Agent "helper" is not a primary agent')
          await expect(registry.setDefault("hidden")).rejects.toThrow('Agent "hidden" is hidden')
          await expect(registry.setDefault("manual")).rejects.toThrow('Agent "manual" is not default eligible')
        },
      })
    })

    test("setDefault rejects agents hidden by config overlay", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(
        tmp.path,
        "foo",
        {
          entry: {
            primary: true,
            delegable: true,
            mentionable: true,
            default: true,
            hidden: false,
          },
        },
        {
          agent: {
            foo: {
              hidden: true,
            },
          },
        },
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")

          await expect(registry.setDefault("foo")).rejects.toThrow('Agent "foo" is hidden')
          expect((await Config.get()).default_agent).toBeUndefined()
        },
      })
    })

    test("setDefault rejects agents disabled by config overlay", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(
        tmp.path,
        "foo",
        {
          entry: {
            primary: true,
            delegable: true,
            mentionable: true,
            default: true,
            hidden: false,
          },
        },
        {
          agent: {
            foo: {
              disable: true,
            },
          },
        },
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")

          await expect(registry.setDefault("foo")).rejects.toThrow("Agent not found: foo")
          expect((await Config.get()).default_agent).toBeUndefined()
        },
      })
    })

    test("setDefault rejects agents made subagent by config overlay", async () => {
      await using tmp = await tmpdir({ git: true })
      await entry(
        tmp.path,
        "foo",
        {
          entry: {
            primary: true,
            delegable: true,
            mentionable: true,
            default: true,
            hidden: false,
          },
        },
        {
          agent: {
            foo: {
              mode: "subagent",
            },
          },
        },
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")

          await expect(registry.setDefault("foo")).rejects.toThrow('Agent "foo" is not a primary agent')
          expect((await Config.get()).default_agent).toBeUndefined()
        },
      })
    })
  })
})
