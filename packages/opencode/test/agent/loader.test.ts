import { test, expect, describe, beforeEach } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { AgentTemplateLoader } from "../../src/agent/loader"

describe("AgentTemplateLoader", () => {
  const loader = new AgentTemplateLoader()

  describe("directory scanning", () => {
    test("discovers agent templates in config/agents/", async () => {
      // The loader should scan config/agents/ and find the default agent
      const agents = await loader.loadAll()
      expect(agents.length).toBeGreaterThan(0)
    })

    test("returns empty array when no agents exist", async () => {
      const emptyLoader = new AgentTemplateLoader("/nonexistent/path")
      const agents = await emptyLoader.loadAll()
      expect(agents).toEqual([])
    })

    test("discovers multiple agent templates", async () => {
      const agents = await loader.loadAll()
      const ids = agents.map((a) => a.id)
      // Should find the default agent
      expect(ids).toContain("default")
    })
  })

  describe("file parsing", () => {
    test("parses meta.json correctly", async () => {
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()
      if (!defaultAgent) return

      expect(defaultAgent.meta.id).toBe("default")
      expect(defaultAgent.meta.name).toBe("Default Agent")
      expect(defaultAgent.meta.role).toBeTruthy()
      expect(defaultAgent.meta.description).toBeTruthy()
    })

    test("parses identity.md content", async () => {
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()
      if (!defaultAgent) return

      expect(defaultAgent.identity).toBeTruthy()
      expect(typeof defaultAgent.identity).toBe("string")
      expect(defaultAgent.identity.length).toBeGreaterThan(0)
    })

    test("parses rules.md content", async () => {
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()
      if (!defaultAgent) return

      expect(defaultAgent.rules).toBeTruthy()
      expect(typeof defaultAgent.rules).toBe("string")
      expect(defaultAgent.rules.length).toBeGreaterThan(0)
    })

    test("handles missing identity.md gracefully", async () => {
      // Create a temp directory with only meta.json
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const agentDir = path.join(tmp, "no-identity")
        await fs.mkdir(agentDir)
        await fs.writeFile(
          path.join(agentDir, "meta.json"),
          JSON.stringify({
            id: "no-identity",
            name: "No Identity Agent",
            role: "test",
            description: "test agent without identity.md",
          }),
        )

        const testLoader = new AgentTemplateLoader(tmp)
        const agents = await testLoader.loadAll()
        expect(agents.length).toBe(1)
        expect(agents[0].identity).toBe("")
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("handles missing rules.md gracefully", async () => {
      // Create a temp directory with only meta.json and identity.md
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const agentDir = path.join(tmp, "no-rules")
        await fs.mkdir(agentDir)
        await fs.writeFile(
          path.join(agentDir, "meta.json"),
          JSON.stringify({
            id: "no-rules",
            name: "No Rules Agent",
            role: "test",
            description: "test agent without rules.md",
          }),
        )
        await fs.writeFile(path.join(agentDir, "identity.md"), "# Identity\n\nTest identity content.")

        const testLoader = new AgentTemplateLoader(tmp)
        const agents = await testLoader.loadAll()
        expect(agents.length).toBe(1)
        expect(agents[0].rules).toBe("")
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })
  })

  describe("error handling", () => {
    test("logs warning for malformed meta.json but continues loading", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const agentDir = path.join(tmp, "bad-meta")
        await fs.mkdir(agentDir)
        await fs.writeFile(
          path.join(agentDir, "meta.json"),
          JSON.stringify({
            id: "bad-meta",
            name: "Bad Meta Agent",
            // missing required 'role' and 'description'
          }),
        )
        await fs.writeFile(path.join(agentDir, "identity.md"), "# Identity\n\nTest")
        await fs.writeFile(path.join(agentDir, "rules.md"), "# Rules\n\nTest")

        const testLoader = new AgentTemplateLoader(tmp)
        // Should not throw, but should skip the bad agent
        const agents = await testLoader.loadAll()
        // The bad-meta agent should not be included due to validation failure
        expect(agents.find((a) => a.id === "bad-meta")).toBeUndefined()
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("logs warning for invalid json in meta.json but continues loading", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const goodDir = path.join(tmp, "good-agent")
        await fs.mkdir(goodDir)
        await fs.writeFile(
          path.join(goodDir, "meta.json"),
          JSON.stringify({
            id: "good-agent",
            name: "Good Agent",
            role: "test",
            description: "A valid agent",
          }),
        )
        await fs.writeFile(path.join(goodDir, "identity.md"), "# Identity\n\nTest")
        await fs.writeFile(path.join(goodDir, "rules.md"), "# Rules\n\nTest")

        const badDir = path.join(tmp, "bad-json")
        await fs.mkdir(badDir)
        await fs.writeFile(path.join(badDir, "meta.json"), "{ invalid json }")
        await fs.writeFile(path.join(badDir, "identity.md"), "# Identity\n\nTest")
        await fs.writeFile(path.join(badDir, "rules.md"), "# Rules\n\nTest")

        const testLoader = new AgentTemplateLoader(tmp)
        const agents = await testLoader.loadAll()
        // Good agent should still be loaded
        expect(agents.find((a) => a.id === "good-agent")).toBeDefined()
        // Bad json agent should not be loaded
        expect(agents.find((a) => a.id === "bad-json")).toBeUndefined()
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })
  })

  describe("performance", () => {
    test("loads many agents within 1s", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-perf-"))
      try {
        // Create 50 agents
        for (let i = 0; i < 50; i++) {
          const agentDir = path.join(tmp, `agent-${i}`)
          await fs.mkdir(agentDir)
          await fs.writeFile(
            path.join(agentDir, "meta.json"),
            JSON.stringify({
              id: `agent-${i}`,
              name: `Agent ${i}`,
              role: "test",
              description: `Test agent ${i}`,
            }),
          )
          await fs.writeFile(path.join(agentDir, "identity.md"), "# Identity\n\nTest identity content.")
          await fs.writeFile(path.join(agentDir, "rules.md"), "# Rules\n\nTest rules content.")
        }

        const testLoader = new AgentTemplateLoader(tmp)
        const start = Date.now()
        const agents = await testLoader.loadAll()
        const duration = Date.now() - start

        expect(agents.length).toBe(50)
        expect(duration).toBeLessThan(1000)
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })
  })

  describe("structured output", () => {
    test("returns proper AgentTemplate structure", async () => {
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()
      if (!defaultAgent) return

      // Check all required fields
      expect(defaultAgent.id).toBe("default")
      expect(defaultAgent.name).toBe("Default Agent")
      expect(defaultAgent.meta).toBeDefined()
      expect(defaultAgent.identity).toBeDefined()
      expect(defaultAgent.rules).toBeDefined()

      // Check meta structure
      expect(defaultAgent.meta.id).toBe("default")
      expect(defaultAgent.meta.name).toBe("Default Agent")
      expect(typeof defaultAgent.meta.role).toBe("string")
      expect(typeof defaultAgent.meta.description).toBe("string")
    })
  })
})
