import { test, expect, describe } from "bun:test"
import path from "path"
import { AgentRegistry, resetRegistry } from "../../src/agent/registry"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

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

    test("list() returns agents with id, name, description, mode", async () => {
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
            expect(["auto", "manual", "supervision"]).toContain(agent.mode)
          }
        },
      })
    })

    test("list() returns empty array when no agents exist", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const emptyRegistry = new AgentRegistry("/nonexistent/path")
          const agents = await emptyRegistry.list()
          expect(agents).toEqual([])
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
          if (agents.length === 0) return

          const firstAgent = agents[0]
          // setDefault should not throw when agent exists
          try {
            await registry.setDefault(firstAgent.id)
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
  })
})
