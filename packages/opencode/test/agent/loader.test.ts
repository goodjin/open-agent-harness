import { test, expect, describe, beforeEach } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { AgentTemplateLoader } from "../../src/agent/loader"
import { AgentRegistry } from "../../src/agent/registry"
import { BUILTIN_AGENTS } from "../../src/agent/builtin.generated"

describe("AgentTemplateLoader", () => {
  const loader = new AgentTemplateLoader()

  async function write(
    dir: string,
    id: string,
    input?: Partial<{ name: string; role: string; description: string; request_footer: unknown }>,
  ) {
    const root = path.join(dir, id)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      path.join(root, "meta.json"),
      JSON.stringify({
        id,
        name: input?.name ?? id,
        role: input?.role ?? "test",
        description: input?.description ?? "test agent",
        ...(input?.request_footer ? { request_footer: input.request_footer } : {}),
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

    test("loads bundled package agents when package directory is absent", async () => {
      const emptyLoader = new AgentTemplateLoader("/nonexistent/path", "/also/nonexistent")
      const agents = await emptyLoader.loadAll()
      const ids = agents.map((item) => item.id)

      expect(ids).toContain("default")
      expect(ids).toContain("frontend")
      expect(ids).toContain("backend")
      expect(ids).toContain("security-reviewer")
      expect(agents.find((item) => item.id === "default")?.source).toBe("package")
      expect(agents.find((item) => item.id === "default")?.meta.runner).toBe("protocol")
    })

    test("built-in default fallback keeps custom planner tool policy", async () => {
      const registry = new AgentRegistry("/nonexistent/path", "/also/nonexistent")
      const agent = await registry.get("default")
      expect(agent?.meta.permission_mode).toBe("custom")
      expect(agent?.meta.allowed_tools).toEqual([
        "task",
        "question",
        "read",
        "glob",
        "grep",
        "codesearch",
        "lsp",
        "external_directory",
        "agent_query",
        "agent_create",
      ])
      expect(agent?.meta.inherit_permissions).toBe(false)
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "*",
          action: "deny",
          source: "agent",
        }),
      )
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "task",
          action: "allow",
          source: "agent",
        }),
      )
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "agent_query",
          action: "allow",
          source: "agent",
        }),
      )
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "agent_create",
          action: "allow",
          source: "agent",
        }),
      )
      expect(agent?.policy.rules).toContainEqual(
        expect.objectContaining({
          permission: "question",
          action: "allow",
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

    test("built-in coordinator planners keep strict graph routing footers", async () => {
      const agent = BUILTIN_AGENTS.find((item) => item.id === "default")
      expect(agent?.rules).toContain("always split work by the project/PRD -> milestone -> feature/capability -> implementation task -> verification/review hierarchy")
      expect(agent?.rules).toContain("Do not emit a single worker item whose prompt asks that worker to discover and execute the whole remaining plan")
      expect(agent?.meta.request_footer?.prompt).toContain("Requirement First / Assisted Review")
      expect(agent?.meta.request_footer?.prompt).toContain("call the native AgentProtocolOutput tool exactly once")
      expect(agent?.meta.concurrency).toBe(-1)
      expect(agent?.rules).toContain("## Assisted Requirement Analysis")
      expect(agent?.rules).toContain("Use `requirement-reviewer` for completeness")
      expect(agent?.rules).toContain("Do not emit a fixed requirement JSON schema")
      expect(agent?.rules).toContain("Use `general-executor` only for bounded cross-domain implementation")

      ;["milestone-planner", "feature-planner"].forEach((id) => {
        const planner = BUILTIN_AGENTS.find((item) => item.id === id)
        expect(planner?.meta.request_footer?.prompt).toContain("Assisted Design / Independent Review")
        expect(planner?.meta.request_footer?.prompt).toContain("Call AgentProtocolOutput exactly once")
        expect(planner?.rules).toContain("without asking for the next small step")
        expect(planner?.rules).toContain("There is no fixed combination")
        expect(planner?.rules).toContain("call independent reviewers matched to its content")
      })
      const milestone = BUILTIN_AGENTS.find((item) => item.id === "milestone-planner")
      expect(milestone?.rules).toContain("one concise Markdown milestone handoff")
      expect(milestone?.rules).toContain("Use `requirement-reviewer` for completeness")
      expect(BUILTIN_AGENTS.find((item) => item.id === "feature-planner")?.rules).toContain(
        "create read-only consultation sessions",
      )
    })

    test("built-in programming team exposes specialist consultation and delivery roles", async () => {
      const agents = await loader.loadAll()
      const target = {
        "software-architect": ["helper", "architecture_design", false],
        "test-engineer": ["worker", "test_implementation", true],
        "code-reviewer": ["verifier", "code_review", false],
        "design-reviewer": ["verifier", "design_review", false],
        "requirement-analyst": ["helper", "requirement_analysis", false],
        "domain-analyst": ["helper", "domain_analysis", false],
        "acceptance-analyst": ["helper", "acceptance_analysis", false],
        "requirement-reviewer": ["verifier", "requirement_review", false],
        "routing-reviewer": ["verifier", "routing_review", false],
        debugger: ["helper", "debugging", false],
        frontend: ["worker", "frontend_implementation", true],
        backend: ["worker", "backend_implementation", true],
        "database-agent": ["worker", "database", true],
        "devops-agent": ["worker", "devops", true],
      } as const

      Object.entries(target).forEach(([id, row]) => {
        const agent = agents.find((item) => item.id === id)
        expect(agent).toBeDefined()
        expect(agent?.meta.kind).toBe(row[0])
        expect(agent?.meta.capability.purpose).toBe(row[1])
        expect(agent?.meta.capability.writes).toBe(row[2])
        expect(agent?.meta.entry).toEqual({
          primary: false,
          delegable: true,
          mentionable: false,
          default: false,
          hidden: false,
        })
      })
    })

    test("built-in agents keep planner and action protocols isolated", () => {
      ;["default", "milestone-planner", "feature-planner", "protocol-runner"].forEach((id) => {
        const agent = BUILTIN_AGENTS.find((item) => item.id === id)
        expect(agent?.meta.runner).toBe("protocol")
        expect(agent?.protocol?.file).toBe("planner-protocol.md")
        expect(agent?.protocol?.prompt).toContain("This is the planner/coordinator protocol")
        expect(agent?.protocol?.prompt).not.toContain("Worker result fields")
      })

      ;[
        "backend",
        "frontend",
        "general-executor",
        "test-engineer",
        "verifier",
        "code-reviewer",
        "design-reviewer",
        "backend-verifier",
      ].forEach((id) => {
        const agent = BUILTIN_AGENTS.find((item) => item.id === id)
        expect(agent?.requestFooter?.file).toBe("action-protocol.md")
        expect(agent?.requestFooter?.prompt).toContain("You are running as an action agent")
        expect(agent?.requestFooter?.prompt).toContain("terminal but non-satisfying result")
        expect(agent?.protocol).toBeUndefined()
      })
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

    test("loads request footer prompt from shared fallback directory", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      const fallback = await fs.mkdtemp(path.join("/tmp", "agent-loader-fallback-"))
      try {
        await fs.mkdir(path.join(fallback, "request-footers"), { recursive: true })
        await fs.writeFile(path.join(fallback, "request-footers", "handoff.md"), "Footer {{action_id}}")
        await write(tmp, "footer-agent", {
          request_footer: {
            file: "handoff.md",
          },
        })

        const testLoader = new AgentTemplateLoader(tmp, fallback)
        const agents = await testLoader.loadAll()
        const agent = agents.find((item) => item.id === "footer-agent")

        expect(agent?.requestFooter?.file).toBe("handoff.md")
        expect(agent?.requestFooter?.prompt).toBe("Footer {{action_id}}")
      } finally {
        await fs.rm(tmp, { recursive: true })
        await fs.rm(fallback, { recursive: true })
      }
    })

    test("package templates expose built-in target entry and capability semantics", async () => {
      const target = {
        default: ["coordination", "medium", false, true, true, true, true, false],
        "general-investigator": ["investigation", "low", false, false, true, true, false, false],
        "general-executor": ["implementation", "medium", true, false, true, true, false, false],
        "general-executor-verifier": ["general_execution_verification", "low", false, false, false, false, false, true],
        explore: ["code_search", "low", false, false, false, false, false, true],
        compaction: ["system_compaction", "low", false, false, false, false, false, true],
        title: ["system_title", "low", false, false, false, false, false, true],
        summary: ["system_summary", "low", false, false, false, false, false, true],
        "technical-reviewer": ["technical_review", "high", false, false, true, true, false, false],
        librarian: ["source_research", "low", false, false, false, false, false, true],
        "plan-reviewer": ["plan_review", "medium", false, false, false, false, false, true],
        "multimodal-looker": ["media_interpretation", "low", false, false, true, true, false, false],
        "workflow-runner": ["workflow_profile_management", "low", true, false, false, false, false, true],
        "protocol-runner": ["protocol_orchestration", "low", false, false, false, false, false, true],
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

    test("package templates omit redundant legacy fallback agents", async () => {
      const agents = await loader.loadAll()
      const ids = agents.map((item) => item.id)

      expect(ids).not.toContain("hephaestus")
      expect(ids).not.toContain("hephaestus-verifier")
      expect(ids).not.toContain("sisyphus")
      expect(ids).not.toContain("sisyphus-verifier")
      expect(ids).not.toContain("sisyphus-junior")
      expect(ids).not.toContain("sisyphus-junior-verifier")
      expect(ids).not.toContain("atlas")
      expect(ids).not.toContain("atlas-verifier")
      expect(ids).not.toContain("prometheus")
      expect(ids).not.toContain("general")
      expect(ids).not.toContain("plan")
      expect(ids).not.toContain("requirements-clarifier")
    })

    test("package templates default to chat runner except special runners", async () => {
      const agents = await loader.loadAll()

      for (const agent of agents.filter((item) => item.source === "package")) {
        const expected =
          agent.id === "workflow-runner" ||
          agent.id === "migration-runner" ||
          agent.id === "release-runner" ||
          agent.id === "data-migration-runner" ||
          agent.id === "incident-responder"
            ? "workflow"
            : agent.id === "protocol-runner" ||
                agent.id === "default" ||
                agent.id === "milestone-planner" ||
                agent.id === "epic-planner" ||
                agent.id === "feature-planner"
              ? "protocol"
              : "chat"
        expect(agent.meta.runner).toBe(expected)
      }
    })

    test("migration-runner package template exposes workflow metadata", async () => {
      const agents = await loader.loadAll()
      const agent = agents.find((item) => item.id === "migration-runner")

      expect(agent).toBeDefined()
      expect(agent?.meta.runner).toBe("workflow")
      expect(agent?.meta.capability.purpose).toBe("migration")
      expect(agent?.identity).toContain("many files")
      expect(agent?.rules).toContain("persistent Action Graph")
    })

    test("workflow-runner package template exposes workflow metadata", async () => {
      const agents = await loader.loadAll()
      const agent = agents.find((item) => item.id === "workflow-runner")

      expect(agent).toBeDefined()
      expect(agent?.meta.runner).toBe("workflow")
      expect(agent?.meta.capability.purpose).toBe("workflow_profile_management")
      expect(agent?.identity).toContain("Workflow assets")
      expect(agent?.rules).toContain("workflow.create")
    })

    test("protocol-runner package template exposes protocol metadata", async () => {
      const agents = await loader.loadAll()
      const agent = agents.find((item) => item.id === "protocol-runner")

      expect(agent).toBeDefined()
      expect(agent?.meta.runner).toBe("protocol")
      expect(agent?.meta.capability.purpose).toBe("protocol_orchestration")
      expect(agent?.meta.auto_append_prompt).toContain("AgentProtocolOutput")
      expect(agent?.identity).toContain("Agent Protocol")
      expect(agent?.rules).toBe("")
    })

    test("registry exposes workflow-runner runner metadata", async () => {
      const registry = new AgentRegistry()
      const agent = await registry.get("workflow-runner")

      expect(agent?.runner).toBe("workflow")
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

    test("converts legacy skills into virtual agent templates", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const dir = path.join(tmp, "skill", "reviewer")
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, "SKILL.md"),
          [
            "---",
            "name: code-reviewer",
            "description: Use when reviewing code changes.",
            "---",
            "",
            "# Code Reviewer",
            "",
            "## Role",
            "",
            "You review code for bugs.",
            "",
            "## Workflow",
            "",
            "- Read the diff.",
            "- Return findings first.",
            "",
          ].join("\n"),
        )

        const testLoader = new AgentTemplateLoader(path.join(tmp, "agents"), "/nonexistent/fallback")
        const agents = await testLoader.loadAll()
        const agent = agents.find((item) => item.id === "code-reviewer")
        expect(agent?.source).toBe("user")
        expect(agent?.meta.kind).toBe("skill")
        expect(agent?.meta.description).toBe("Use when reviewing code changes.")
        expect(agent?.meta.entry.primary).toBe(false)
        expect(agent?.meta.capability.purpose).toBe("legacy_skill")
        expect(agent?.meta.schema_version).toBeUndefined()
        expect(agent?.meta.instructions).toBeUndefined()
        expect(agent?.meta.contracts).toBeUndefined()
        expect(agent?.meta.collaboration).toBeUndefined()
        expect(agent?.identity).toContain("You review code for bugs.")
        expect(agent?.rules).toContain("Read the diff.")
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("loads claude skills as virtual agent templates", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const dir = path.join(tmp, ".claude", "skills", "planner")
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, "SKILL.md"),
          [
            "---",
            "name: claude-planner",
            "description: Use when planning work from Claude skills.",
            "---",
            "",
            "# Claude Planner",
            "",
            "Plan the work.",
            "",
          ].join("\n"),
        )

        const testLoader = new AgentTemplateLoader(
          path.join(tmp, "agents"),
          "/nonexistent/fallback",
          path.join(tmp, ".claude", "skills"),
        )
        const agents = await testLoader.loadAll()
        const agent = agents.find((item) => item.id === "claude-planner")
        expect(agent?.source).toBe("user")
        expect(agent?.meta.description).toBe("Use when planning work from Claude skills.")
        expect(agent?.meta.capability.purpose).toBe("legacy_skill")
        expect(agent?.identity).toBe("You are the Claude Planner agent converted from a legacy skill.")
        expect(agent?.rules).toContain("Plan the work.")
        expect(agent?.identity).not.toBe(agent?.rules)
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("agent templates override converted skills with the same id", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const skill = path.join(tmp, "skill", "writer")
        await fs.mkdir(skill, { recursive: true })
        await fs.writeFile(
          path.join(skill, "SKILL.md"),
          ["---", "name: writer", "description: Skill writer", "---", "", "# Writer", "", "Skill prompt."].join("\n"),
        )
        await write(path.join(tmp, "agents"), "writer", { name: "Agent Writer", description: "Agent writer" })

        const testLoader = new AgentTemplateLoader(path.join(tmp, "agents"), "/nonexistent/fallback")
        const agents = await testLoader.loadAll()
        const agent = agents.find((item) => item.id === "writer")
        expect(agent?.name).toBe("Agent Writer")
        expect(agent?.meta.description).toBe("Agent writer")
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("loads RFC metadata while keeping legacy identity and rules files", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const dir = path.join(tmp, "metadata-agent")
        await fs.mkdir(dir)
        await fs.writeFile(
          path.join(dir, "meta.json"),
          JSON.stringify({
            schema_version: "agent.metadata.v1",
            agent_version: "1.0.0",
            id: "metadata-agent",
            name: "Metadata Agent",
            persona: "metadata persona",
            description: "metadata test",
            logo: {
              uri: "./logo.svg",
              alt: "Metadata",
            },
            instructions: {
              files: [
                {
                  path: "playbook.md",
                  role: "system",
                  required: false,
                },
              ],
              model_messages: [
                {
                  on: "start",
                  position: "after_identity",
                  content: "do not inject during load",
                },
              ],
            },
            contracts: {
              input: [{ schema_ref: "#/$defs/input" }],
              output: [{ schema_ref: "#/$defs/output" }],
            },
            collaboration: {
              edges: [{ target: "other-agent", relation: "hands_off" }],
            },
            completion: {
              criteria: ["done"],
            },
          }),
        )
        await fs.writeFile(path.join(dir, "identity.md"), "# Identity\n\nLegacy identity.")
        await fs.writeFile(path.join(dir, "rules.md"), "# Rules\n\nLegacy rules.")

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const result = await testLoader.load()
        const agent = result.templates.find((item) => item.id === "metadata-agent")

        expect(agent?.meta.schema_version).toBe("agent.metadata.v1")
        expect(agent?.meta.role).toBe("metadata persona")
        expect(agent?.meta.inherit_permissions).toBe(false)
        expect(agent?.meta.instructions?.files[0]?.path).toBe("playbook.md")
        expect(agent?.meta.contracts?.input[0]?.schema_ref).toBe("#/$defs/input")
        expect(agent?.meta.collaboration?.edges[0]?.target).toBe("other-agent")
        expect(agent?.identity).toContain("Legacy identity.")
        expect(agent?.rules).toContain("Legacy rules.")
        expect(agent?.identity).not.toContain("do not inject during load")
        expect(result.diagnostics.filter((item) => item.dir === dir)).toEqual([])
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

    test("warns for metadata diagnostics without blocking load", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-loader-test-"))
      try {
        const dir = path.join(tmp, "metadata-warnings")
        await fs.mkdir(dir)
        await fs.writeFile(
          path.join(dir, "meta.json"),
          JSON.stringify({
            schema_version: "agent.metadata.v1",
            id: "metadata-warnings",
            name: "Metadata Warnings",
            role: "test",
            description: "metadata warnings",
            logo: {
              uri: "ftp://example.com/logo.svg",
            },
            instructions: {
              files: [
                {
                  path: "../missing.md",
                  required: true,
                },
              ],
            },
            contracts: {
              input: [{ schema_ref: 1 }],
              output: [{ schema_ref: "" }],
            },
            collaboration: {
              edges: [{ kind: "handoff" }],
            },
          }),
        )
        await fs.writeFile(path.join(dir, "identity.md"), "# Identity")
        await fs.writeFile(path.join(dir, "rules.md"), "# Rules")

        const testLoader = new AgentTemplateLoader(tmp, "/nonexistent/fallback")
        const result = await testLoader.load()
        const fields = result.diagnostics.filter((item) => item.dir === dir).map((item) => item.field)

        expect(result.templates.find((item) => item.id === "metadata-warnings")).toBeDefined()
        expect(result.statuses.find((item) => item.dir === dir)?.valid).toBe(true)
        expect(fields).toContain("logo.uri")
        expect(fields).toContain("instructions.files.0.path")
        expect(fields).toContain("contracts.input.0.schema_ref")
        expect(fields).toContain("contracts.output.0.schema_ref")
        expect(fields).toContain("collaboration.edges.0.target")
        expect(result.diagnostics.find((item) => item.field === "instructions.files.0.path")?.category).toBe(
          "metadata.instructions",
        )
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

        // User agents + bundled package agents
        expect(agents.length).toBe(50 + BUILTIN_AGENTS.length)
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
