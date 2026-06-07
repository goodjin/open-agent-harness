import { test, expect, describe } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { AgentTemplateLoader } from "../../src/agent/loader"
import { AgentRegistry } from "../../src/agent/registry"

async function agent(dir: string, id: string, meta: Record<string, unknown>) {
  const root = path.join(dir, id)
  const base = "persona" in meta ? {} : { role: `${id} role` }
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({
      id,
      name: id,
      description: `${id} agent`,
      ...base,
      ...meta,
    }),
  )
  await fs.writeFile(path.join(root, "identity.md"), `# Identity\n\n${id} legacy identity.`)
  await fs.writeFile(path.join(root, "rules.md"), `# Rules\n\n${id} legacy rules.`)
  return root
}

describe("Agent metadata v1 E2E scenarios", () => {
  test("loads research prerequisite chain metadata without migrating legacy files", async () => {
    const tmp = await fs.mkdtemp(path.join("/tmp", "agent-metadata-e2e-"))
    try {
      await agent(tmp, "researcher", {
        schema_version: "agent.metadata.v1",
        persona: "Collect prerequisite facts before implementation starts.",
        capability: {
          purpose: "source_research",
          tags: ["research", "prerequisite"],
          cost: "low",
          writes: false,
        },
        contracts: {
          input: [{ name: "question", required: true, schema_ref: "#/$defs/question" }],
          output: [{ name: "brief", required: true, schema_ref: "#/$defs/research_brief" }],
        },
        collaboration: {
          edges: [
            {
              id: "research-before-dev",
              kind: "prerequisite",
              target: "developer",
              required: true,
              provides: ["brief"],
            },
          ],
        },
        completion: {
          criteria: ["research brief names sources"],
          required_artifacts: ["brief"],
        },
      })
      await agent(tmp, "legacy-user", {
        role: "Legacy user agent still loads from identity and rules.",
      })

      const res = await new AgentTemplateLoader(tmp, "/missing/package/agents").load()
      const item = res.templates.find((entry) => entry.id === "researcher")
      const old = res.templates.find((entry) => entry.id === "legacy-user")

      expect(item?.meta.schema_version).toBe("agent.metadata.v1")
      expect(item?.meta.role).toBe("Collect prerequisite facts before implementation starts.")
      expect(item?.meta.contracts?.output[0]?.schema_ref).toBe("#/$defs/research_brief")
      expect(item?.meta.collaboration?.edges[0]?.target).toBe("developer")
      expect(item?.identity).toContain("researcher legacy identity.")
      expect(item?.rules).toContain("researcher legacy rules.")
      expect(old?.meta.schema_version).toBeUndefined()
      expect(old?.meta.inherit_permissions).toBe(true)
      expect(old?.identity).toContain("legacy-user legacy identity.")
      expect(res.diagnostics.filter((entry) => entry.dir === item?.dir)).toEqual([])
    } finally {
      await fs.rm(tmp, { recursive: true })
    }
  })

  test("registry exposes dev test review metadata and business approval metadata", async () => {
    const tmp = await fs.mkdtemp(path.join("/tmp", "agent-metadata-e2e-"))
    try {
      await agent(tmp, "developer", {
        schema_version: "agent.metadata.v1",
        persona: "Implement a focused change and hand evidence to test and review agents.",
        entry: {
          primary: true,
          delegable: true,
          mentionable: true,
          default: true,
          hidden: false,
        },
        capability: {
          purpose: "implementation",
          tags: ["dev", "test", "review"],
          cost: "medium",
          writes: true,
        },
        collaboration: {
          edges: [
            {
              id: "run-tests",
              kind: "verification",
              target: "tester",
              required: true,
            },
            {
              id: "review-after-tests",
              kind: "review",
              target: "reviewer",
              required: true,
            },
          ],
        },
        completion: {
          mode: "runtime_verified",
          required_evidence: ["test_output", "review_findings"],
          gates: [{ name: "tests", requires: "tester" }],
        },
      })
      await agent(tmp, "approval", {
        schema_version: "agent.metadata.v1",
        persona: "Pause work when business approval is needed.",
        capability: {
          purpose: "business_approval",
          tags: ["approval", "business"],
          cost: "low",
          writes: false,
        },
        runtime_boundary: {
          approval: {
            required: true,
            approver: "business_owner",
            reason: "scope_or_cost_change",
          },
        },
        completion: {
          criteria: ["approval decision is recorded"],
          required_evidence: ["approval_record"],
        },
      })

      const registry = new AgentRegistry(tmp, "/missing/package/agents")
      const dev = await registry.get("developer")
      const approval = await registry.get("approval")

      expect(dev?.meta.schema_version).toBe("agent.metadata.v1")
      expect(dev?.meta.collaboration?.edges.map((entry) => entry.target)).toEqual(["tester", "reviewer"])
      expect(dev?.meta.completion?.required_evidence).toEqual(["test_output", "review_findings"])
      expect(dev?.identity).toContain("developer legacy identity.")
      expect(approval?.meta.runtime_boundary?.approval).toEqual({
        required: true,
        approver: "business_owner",
        reason: "scope_or_cost_change",
      })
      expect(approval?.meta.completion?.required_evidence).toEqual(["approval_record"])
      expect(approval?.rules).toContain("approval legacy rules.")
    } finally {
      await fs.rm(tmp, { recursive: true })
    }
  })
})
