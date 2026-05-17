import { test, expect, describe, beforeEach } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { AgentTemplateLoader } from "../../src/agent/loader"
import { AgentRegistry } from "../../src/agent/registry"

describe("AgentTemplateLoader", () => {
  const loader = new AgentTemplateLoader()

  async function write(dir: string, id: string, input?: Partial<{ name: string; role: string; description: string }>) {
    const root = path.join(dir, id)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      path.join(root, "meta.json"),
      JSON.stringify({
        id,
        name: input?.name ?? id,
        role: input?.role ?? "test",
        description: input?.description ?? "test agent",
      }),
    )
    await fs.writeFile(path.join(root, "identity.md"), "# Identity")
    await fs.writeFile(path.join(root, "rules.md"), "# Rules")
    return root
  }

  describe("directory scanning", () => {
    test("discovers agent templates in config/agents/", async () => {
      // The loader should scan config/agents/ and find the default agent
      const agents = await loader.loadAll()
      expect(agents.length).toBeGreaterThan(0)
    })

    test("always returns built-in default agent as fallback", async () => {
      const emptyLoader = new AgentTemplateLoader("/nonexistent/path", "/also/nonexistent")
      const agents = await emptyLoader.loadAll()
      // Should always have built-in default agent
      expect(agents.find((a) => a.id === "default")).toBeDefined()
      expect(agents.length).toBeGreaterThanOrEqual(1)
    })

    test("built-in default fallback keeps custom allowed tool policy", async () => {
      const registry = new AgentRegistry("/nonexistent/path", "/also/nonexistent")
      const agent = await registry.get("default")
      expect(agent?.meta.permission_mode).toBe("custom")
      expect(agent?.meta.allowed_tools).toContain("read")
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "*",
          action: "deny",
          source: "agent",
        }),
      )
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "read",
          action: "allow",
          source: "agent",
        }),
      )
    })

    test("discovers multiple agent templates", async () => {
      const agents = await loader.loadAll()
      const ids = agents.map((a) => a.id)
      // Should find the default agent
      expect(ids).toContain("default")
    })

    test("loads package fallback templates for runtime agents", async () => {
      const agents = await loader.loadAll()
      const ids = agents.map((a) => a.id)
      expect(ids).toContain("compaction")
      expect(ids).toContain("title")
    })

    test("package templates expose built-in target entry and capability semantics", async () => {
      const target = {
        build: ["implementation", "medium", true, true, true, true, true, false],
        plan: ["planning_analysis", "low", false, true, true, true, false, false],
        general: ["general_research", "medium", true, false, true, true, false, false],
        explore: ["code_search", "low", false, false, true, true, false, false],
        compaction: ["system_compaction", "low", false, false, false, false, false, true],
        title: ["system_title", "low", false, false, false, false, false, true],
        summary: ["system_summary", "low", false, false, false, false, false, true],
        sisyphus: ["orchestration", "high", true, true, true, true, true, false],
        hephaestus: ["deep_implementation", "high", true, true, true, true, false, false],
        prometheus: ["plan_building", "high", true, true, true, true, false, false],
        atlas: ["plan_execution", "high", true, true, true, true, false, false],
        "sisyphus-junior": ["focused_execution", "medium", true, false, true, true, false, false],
        oracle: ["technical_advice", "high", false, false, true, true, false, false],
        librarian: ["source_research", "low", false, false, true, true, false, false],
        metis: ["pre_planning", "medium", false, false, true, true, false, false],
        momus: ["plan_review", "medium", false, false, true, true, false, false],
        "multimodal-looker": ["media_interpretation", "low", false, false, true, true, false, false],
      } as const
      const agents = await loader.loadAll()

      Object.entries(target).forEach(([id, row]) => {
        const agent = agents.find((item) => item.id === id)
        expect(agent).toBeDefined()
        if (!agent) return

        expect(agent.meta.mode).toBeUndefined()
        expect(agent.meta.capability.purpose).toBe(row[0])
        expect(agent.meta.capability.cost).toBe(row[1])
        expect(agent.meta.capability.writes).toBe(row[2])
        expect(agent.meta.entry).toEqual({
          primary: row[3],
          delegable: row[4],
          mentionable: row[5],
          default: row[6],
          hidden: row[7],
        })
      })
    })

    test("loads package templates before user templates so user overrides package", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const pkg = path.join(tmp, "pkg")
        const user = path.join(tmp, "user")
        await write(pkg, "shared", { name: "Package Agent", description: "package" })
        await write(user, "shared", { name: "User Agent", description: "user" })

        const testLoader = new AgentTemplateLoader(user, pkg)
        const agents = await testLoader.loadAll()
        const agent = agents.find((item) => item.id === "shared")
        expect(agent?.name).toBe("User Agent")
        expect(agent?.source).toBe("user")
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
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

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const agents = await testLoader.loadAll()
        const agent = agents.find((a) => a.id === "no-identity")
        expect(agent).toBeDefined()
        expect(agent!.identity).toBe("")
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

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const agents = await testLoader.loadAll()
        const agent = agents.find((a) => a.id === "no-rules")
        expect(agent).toBeDefined()
        expect(agent!.rules).toBe("")
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

    test("returns valid templates and diagnostics for malformed templates", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        await write(tmp, "good-agent", { name: "Good Agent" })
        const bad = path.join(tmp, "bad-json")
        await fs.mkdir(bad)
        await fs.writeFile(path.join(bad, "meta.json"), "{ invalid json }")

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const result = await testLoader.load()
        expect(result.templates.find((item) => item.id === "good-agent")).toBeDefined()
        expect(result.templates.find((item) => item.id === "bad-json")).toBeUndefined()
        expect(result.diagnostics.length).toBeGreaterThan(0)
        expect(result.statuses.find((item) => item.dir === bad)?.valid).toBe(false)
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("rejects directory mismatch during loading", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        await write(tmp, "valid-agent")

        const mismatch = path.join(tmp, "mismatch")
        await fs.mkdir(mismatch)
        await fs.writeFile(
          path.join(mismatch, "meta.json"),
          JSON.stringify({
            id: "different",
            name: "Mismatch",
            role: "test",
            description: "test",
          }),
        )

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const result = await testLoader.load()
        expect(result.templates.find((item) => item.id === "valid-agent")).toBeDefined()
        expect(result.templates.find((item) => item.id === "different")).toBeUndefined()
        expect(result.statuses.filter((item) => !item.valid).length).toBe(1)
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

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const start = Date.now()
        const agents = await testLoader.loadAll()
        const duration = Date.now() - start

        // User agents + built-in default (always included)
        expect(agents.length).toBe(51)
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
