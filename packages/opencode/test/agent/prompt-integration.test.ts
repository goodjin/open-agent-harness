import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { AgentRegistry, resetRegistry } from "../../src/agent/registry"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { MessageID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

const ent = {
  primary: true,
  delegable: true,
  mentionable: true,
  default: true,
  hidden: false,
}
const cap = {
  purpose: "test",
  tags: [],
  cost: "low",
  writes: true,
} satisfies Agent.Info["capability"]

async function write(dir: string, id: string) {
  const root = path.join(dir, ".opencode", "agents", id)
  await fs.mkdir(root, { recursive: true })
  await Bun.write(
    path.join(root, "meta.json"),
    JSON.stringify(
      {
        id,
        name: "Custom Agent",
        role: "Custom role contract.",
        description: "Custom prompt test agent.",
        model_preference: {
          providerID: "openai",
          modelID: "gpt-5.2",
        },
      },
      null,
      2,
    ),
  )
  await Bun.write(path.join(root, "identity.md"), "# Identity\n\nCustom identity section.")
  await Bun.write(path.join(root, "rules.md"), "# Rules\n\nCustom rules section.")
}

describe("agent prompt integration", () => {
  test("default agent prompt injects identity before rules", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("agent-prompt-default"),
          fn: async () => {
            resetRegistry()
            const agent = await Agent.get("default")
            expect(agent?.prompt).toContain("# Identity")
            expect(agent?.prompt).toContain("# Behavioral Rules")
            expect(agent!.prompt!.indexOf("# Identity")).toBeLessThan(agent!.prompt!.indexOf("# Behavioral Rules"))
          },
        }),
    })
  })

  test("custom agent prompt snapshot stays stable", async () => {
    await using tmp = await tmpdir({ git: true })
    await write(tmp.path, "custom")

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("agent-prompt-custom"),
          fn: async () => {
            resetRegistry()
            const agent = await Agent.get("custom")
            expect(agent?.prompt).toBe(
              [
                "Custom role contract.",
                "# Identity\n\nCustom identity section.",
                "# Rules\n\nCustom rules section.",
              ].join("\n\n"),
            )
          },
        }),
    })
  })

  test("workflow runner prompt instructs workflow json generation", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("agent-prompt-workflow-runner"),
          fn: async () => {
            resetRegistry()
            const agent = await Agent.get("workflow-runner")
            expect(agent?.prompt).toContain("deciding when a user request should become a durable workflow DAG")
            expect(agent?.prompt).toContain("At the start of each new user request")
            expect(agent?.prompt).toContain("Prefer workflow DSL for multi-step tasks by default")
            expect(agent?.prompt).toContain("Current Executable Workflow Schema")
            expect(agent?.prompt).toContain("capabilities")
            expect(agent?.prompt).toContain("Defaults to `auto`")
            expect(agent?.prompt).toContain("agent capability profiles")
            expect(agent?.prompt).toContain("call the `workflow_create` tool")
            expect(agent?.prompt).toContain("pass the workflow as an object")
            expect(agent?.prompt).toContain("must be an object, not JSON text")
            expect(agent?.prompt).toContain("call `workflow_start` only when the user asked to execute")
            expect(agent?.prompt).toContain("Treat the `workflow_start` tool result as an authoritative start acknowledgement")
            expect(agent?.prompt).toContain("Treat a `<workflow-result>` event as the authoritative execution result")
            expect(agent?.prompt).toContain("do not repeat the same completed work with ordinary tools")
            expect(agent?.prompt).toContain("Read `summary`, `nodes`, `completed`, `variables`, `pause`, and `error`")
            expect(agent?.prompt).toContain("Any id in `verification.must_pass`")
            expect(agent?.prompt).toContain('"steps"')
          },
        }),
    })
  })

  test("template prompt precedes legacy instructions and user system prompt", () => {
    const sessionID = SessionID.make("session-agent-prompt")
    const agent = {
      name: "custom",
      mode: "primary",
      entry: ent,
      capability: cap,
      options: {},
      permission: [],
      prompt: "Custom role contract.\n\n# Identity\n\nCustom identity section.\n\n# Rules\n\nCustom rules section.",
    } satisfies Agent.Info
    const user = {
      id: MessageID.make("user-agent-prompt"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
      system: "Runtime user system prompt.",
    } satisfies MessageV2.User
    const system = LLM.compose({
      agent,
      user,
      isCodex: false,
      model: { providerID: ProviderID.make("openai"), api: { id: "gpt-5.2" } } as Provider.Model,
      system: ["Instructions from: /workspace/AGENTS.md\nProject instruction."],
    })[0]

    expect(system.indexOf("# Identity")).toBeLessThan(system.indexOf("# Rules"))
    expect(system.indexOf("# Rules")).toBeLessThan(system.indexOf("Instructions from: /workspace/AGENTS.md"))
    expect(system.indexOf("Instructions from: /workspace/AGENTS.md")).toBeLessThan(
      system.indexOf("Runtime user system prompt."),
    )
  })

  test("compaction and title fall back to default prompt when only default exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await write(tmp.path, "default")

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("agent-prompt-fallback"),
          fn: async () => {
            const registry = new AgentRegistry(path.join(tmp.path, ".opencode", "agents"), "/missing/package/agents")
            const agent = await Agent.get("compaction", registry)
            const title = await Agent.get("title", registry)

            expect(agent?.name).toBe("compaction")
            expect(agent?.prompt).toContain("session compaction specialist")
            expect(agent?.prompt).toContain("Custom identity section.")
            expect(title?.name).toBe("title")
            expect(title?.prompt).toContain("compact session titles")
            expect(title?.prompt).toContain("Custom identity section.")
          },
        }),
    })
  })
})
