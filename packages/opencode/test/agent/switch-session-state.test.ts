import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { AgentRegistry, resetRegistry } from "../../src/agent/registry"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionPrompt } from "../../src/session/prompt"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

async function write(dir: string, id: string) {
  const root = path.join(dir, id)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({
      id,
      name: id,
      role: "test",
      description: `${id} agent`,
    }),
  )
  await fs.writeFile(path.join(root, "identity.md"), "# Identity")
  await fs.writeFile(path.join(root, "rules.md"), "# Rules")
}

async function project(dir: string, id: string) {
  const root = path.join(dir, ".opencode", "agents", id)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({
      id,
      name: id,
      role: "test",
      description: `${id} agent`,
      model_preference: {
        providerID: "test",
        modelID: "test",
      },
    }),
  )
  await fs.writeFile(path.join(root, "identity.md"), "# Identity")
  await fs.writeFile(path.join(root, "rules.md"), "# Rules")
}

function createTestUserMessage(sessionID: string, agent: string): MessageV2.Info {
  return {
    id: MessageID.ascending(),
    sessionID: sessionID as Session.Info["id"] extends string ? Session.Info["id"] : never,
    role: "user",
    time: { created: Date.now() },
    agent,
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    tools: {},
    mode: "all",
  } as unknown as MessageV2.Info
}

function createTestAssistantMessage(
  sessionID: string,
  agent: string,
  parentID: MessageID,
): MessageV2.Info {
  return {
    id: MessageID.ascending(),
    sessionID: sessionID as Session.Info["id"] extends string ? Session.Info["id"] : never,
    role: "assistant",
    parentID,
    agent,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: agent,
    path: { cwd: projectRoot, root: projectRoot },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  } as unknown as MessageV2.Info
}

describe("agent switch preserves session state", () => {
  describe("VAL-CROSS-001: Agent Switch Preserves Session State", () => {
    test("switching agents does not lose existing session messages", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              // Create a new session
              const session = await Session.create({})

              // Create a user message with agent A
              const userMsg1 = createTestUserMessage(session.id, "build")
              await Session.updateMessage(userMsg1)

              // Create an assistant message with agent A (build)
              const assistantMsg1 = createTestAssistantMessage(session.id, "build", userMsg1.id)
              await Session.updateMessage(assistantMsg1)

              // Create a tool part (pending tool call from agent A)
              const toolPart1: MessageV2.ToolPart = {
                id: PartID.ascending(),
                messageID: assistantMsg1.id,
                sessionID: session.id,
                type: "tool",
                callID: "call_1",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "ls" },
                  output: "file1.txt\nfile2.txt",
                  title: "Bash",
                  metadata: {},
                  time: { start: Date.now(), end: Date.now() },
                },
              }
              await Session.updatePart(toolPart1)

              // Switch to plan agent (simulating agent switch)
              const userMsg2 = createTestUserMessage(session.id, "plan")
              await Session.updateMessage(userMsg2)

              // Create assistant message with agent B (plan)
              const assistantMsg2 = createTestAssistantMessage(session.id, "plan", userMsg2.id)
              await Session.updateMessage(assistantMsg2)

              // Now verify that switching agents preserved all session state
              const messages = await Session.messages({ sessionID: session.id })

              // Should have 4 messages total (2 user + 2 assistant)
              expect(messages.length).toBe(4)

              // Find messages by agent
              const buildMessages = messages.filter((m) => m.info.agent === "build")
              const planMessages = messages.filter((m) => m.info.agent === "plan")

              // Should have 2 messages from build agent
              expect(buildMessages.length).toBe(2)

              // Should have 2 messages from plan agent
              expect(planMessages.length).toBe(2)

              // Verify the tool part is still associated with build agent's message
              const buildAssistant = buildMessages.find((m) => m.info.role === "assistant")
              expect(buildAssistant).toBeDefined()
              const toolParts = buildAssistant?.parts.filter((p) => p.type === "tool")
              expect(toolParts?.length).toBe(1)
              expect((toolParts?.[0] as MessageV2.ToolPart)?.state.status).toBe("completed")

              // Cleanup
              await Session.remove(session.id)
            },
          }),
      })
    })

    test("new agent can access prior context from old messages", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              // Create a new session
              const session = await Session.create({})

              // Create messages with build agent that establish context
              const userMsg1 = createTestUserMessage(session.id, "build")
              await Session.updateMessage(userMsg1)

              const assistantMsg1 = createTestAssistantMessage(session.id, "build", userMsg1.id)
              await Session.updateMessage(assistantMsg1)

              // Add a text part with build agent's response
              const textPart: MessageV2.TextPart = {
                id: PartID.ascending(),
                messageID: assistantMsg1.id,
                sessionID: session.id,
                type: "text",
                text: "I found the issue in the codebase. Let me fix it.",
              }
              await Session.updatePart(textPart)

              // Now switch to plan agent
              const userMsg2 = createTestUserMessage(session.id, "plan")
              await Session.updateMessage(userMsg2)

              // Create assistant message with plan agent
              const assistantMsg2 = createTestAssistantMessage(session.id, "plan", userMsg2.id)
              await Session.updateMessage(assistantMsg2)

              // Retrieve all messages - this is what the new agent would see as context
              const allMessages = await Session.messages({ sessionID: session.id })
              const allMessagesReversed = [...allMessages].reverse() // oldest first

              // The new plan agent can see all 4 messages (2 from build, 2 from plan)
              expect(allMessagesReversed.length).toBe(4)

              // The context includes the build agent's text part
              const buildAssistant = allMessagesReversed.find(
                (m) => m.info.role === "assistant" && m.info.agent === "build",
              )
              expect(buildAssistant).toBeDefined()
              const buildTextParts = buildAssistant?.parts.filter((p) => p.type === "text")
              expect(buildTextParts?.length).toBe(1)
              expect((buildTextParts?.[0] as MessageV2.TextPart)?.text).toBe(
                "I found the issue in the codebase. Let me fix it.",
              )

              // Cleanup
              await Session.remove(session.id)
            },
          }),
      })
    })

    test("agent registry switch preserves cache (all agents remain loaded)", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          resetRegistry()
          const registry = new AgentRegistry()
          const agents = await registry.list()

          if (agents.length < 2) {
            // Skip if less than 2 agents available
            return
          }

          // Load all agents
          await registry.list()

          // Switch to first agent
          const agent1 = agents[0]
          await registry.switch(agent1.id)
          expect(registry.getCurrentId()).toBe(agent1.id)

          // Switch to second agent
          const agent2 = agents[1]
          await registry.switch(agent2.id)
          expect(registry.getCurrentId()).toBe(agent2.id)

          // Cache should still contain all agents - list should still work
          const allAgents = await registry.list()
          expect(allAgents.length).toBeGreaterThanOrEqual(2)

          // Each agent should still be retrievable from cache
          for (const agent of agents) {
            const template = await registry.get(agent.id)
            expect(template).toBeDefined()
            expect(template?.id).toBe(agent.id)
          }

          // Cleanup
          resetRegistry()
        },
      })
    })

    test("messages preserve their original agent even after switch", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              // Create a new session
              const session = await Session.create({})

              // Create message with build agent
              const userMsg1 = createTestUserMessage(session.id, "build")
              await Session.updateMessage(userMsg1)

              const assistantMsg1 = createTestAssistantMessage(session.id, "build", userMsg1.id)
              await Session.updateMessage(assistantMsg1)

              // Switch to plan agent
              const userMsg2 = createTestUserMessage(session.id, "plan")
              await Session.updateMessage(userMsg2)

              const assistantMsg2 = createTestAssistantMessage(session.id, "plan", userMsg2.id)
              await Session.updateMessage(assistantMsg2)

              // Retrieve messages and verify they preserve original agent
              const messages = await Session.messages({ sessionID: session.id })

              for (const msg of messages) {
                if (msg.info.role === "user") {
                  // User messages should preserve their original agent
                  expect(typeof msg.info.agent).toBe("string")
                  expect(msg.info.agent.length).toBeGreaterThan(0)
                }
                if (msg.info.role === "assistant") {
                  // Assistant messages should preserve their original agent
                  expect(typeof msg.info.agent).toBe("string")
                  expect(msg.info.agent.length).toBeGreaterThan(0)

                  // Original build message should still have "build" as agent
                  if (msg.info.parentID === userMsg1.id) {
                    expect(msg.info.agent).toBe("build")
                  }
                  // New plan message should have "plan" as agent
                  if (msg.info.parentID === userMsg2.id) {
                    expect(msg.info.agent).toBe("plan")
                  }
                }
              }

              // Cleanup
              await Session.remove(session.id)
            },
          }),
      })
    })

    test("registry-backed switch changes the next effective session agent", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-switch-test-"))
      try {
        await write(tmp, "build")
        await write(tmp, "plan")
        await Instance.provide({
          directory: projectRoot,
          fn: async () =>
            WorkspaceContext.provide({
              workspaceID: WorkspaceID.ascending(),
              fn: async () => {
                const registry = new AgentRegistry(tmp, "/nonexistent/fallback")
                const session = await Session.create({})
                const build = await registry.switch("build")
                expect(build?.id).toBe("build")

                const first = createTestUserMessage(session.id, (await registry.getEffectiveAgent())!.id)
                await Session.updateMessage(first)

                const plan = await registry.switch("plan")
                expect(plan?.id).toBe("plan")

                const second = createTestUserMessage(session.id, (await registry.getEffectiveAgent())!.id)
                await Session.updateMessage(second)

                const messages = await Session.messages({ sessionID: session.id })
                expect(messages.map((item) => item.info.agent)).toEqual(["build", "plan"])
                expect(registry.getCurrentId()).toBe("plan")

                await Session.remove(session.id)
              },
            }),
        })
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })

    test("submitting with selected non-default agent preserves message history", async () => {
      const tmp = await fs.mkdtemp(path.join("/tmp", "agent-prompt-test-"))
      try {
        await project(tmp, "build")
        await project(tmp, "plan")
        await Instance.provide({
          directory: tmp,
          fn: async () =>
            WorkspaceContext.provide({
              workspaceID: WorkspaceID.ascending(),
              fn: async () => {
                resetRegistry()
                const session = await Session.create({})

                const first = await SessionPrompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  noReply: true,
                  parts: [{ type: "text", text: "first" }],
                })
                if (first.info.role !== "user") throw new Error("expected user message")
                expect(first.info.agent).toBe("build")

                const second = await SessionPrompt.prompt({
                  sessionID: session.id,
                  agent: "plan",
                  noReply: true,
                  parts: [{ type: "text", text: "second" }],
                })
                if (second.info.role !== "user") throw new Error("expected user message")
                expect(second.info.agent).toBe("plan")

                const messages = await Session.messages({ sessionID: session.id })
                expect(messages.map((item) => item.info.agent)).toEqual(["build", "plan"])

                await Session.remove(session.id)
              },
            }),
        })
      } finally {
        await fs.rm(tmp, { recursive: true })
      }
    })
  })
})
