import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunner } from "../../src/session/runner"
import type { LLM } from "../../src/session/llm"
import { resetRegistry } from "../../src/agent/registry"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

describe("SessionPrompt runner wiring", () => {
  test("session loop routes workflow-runner through SessionRunner", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace"),
            fn: async () => {
              resetRegistry()
              const seen: string[] = []
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process(stream: LLM.StreamInput) {
                    seen.push(stream.agent.runner ?? "chat")
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Runner wiring test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "workflow-runner",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "run workflow",
                })

                const msg = await SessionPrompt.loop({ sessionID: session.id })

                expect(hook).toHaveBeenCalledTimes(1)
                expect(seen).toEqual(["workflow"])
                expect(msg.info.role).toBe("assistant")
                expect(msg.info.agent).toBe("workflow-runner")

                await Session.remove(session.id)
              } finally {
                hook.mockRestore()
              }
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })

  test("session loop strips model-callable tools for protocol-runner", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-protocol"),
            fn: async () => {
              resetRegistry()
              const seen: { tools: number; system: string; prompt: string }[] = []
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process(stream: LLM.StreamInput) {
                    seen.push({ tools: Object.keys(stream.tools).length, system: stream.system.join("\n"), prompt: stream.runtimeTools?.prompt ?? "" })
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Protocol runner tools test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "protocol-runner",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: { read: true, glob: true, grep: true, bash: true },
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "analyze project",
                })

                await SessionPrompt.loop({ sessionID: session.id })

                expect(seen).toHaveLength(1)
                expect(seen[0]?.tools).toBe(0)
                expect(seen[0]?.system).not.toContain("Available Protocol Tools")
                expect(seen[0]?.prompt).toContain("Available Protocol Tools")
                expect(seen[0]?.prompt).toContain("## read")
                expect(seen[0]?.prompt).toContain("## bash")
                expect(seen[0]?.prompt).toContain("input_schema:")
                await Session.remove(session.id)
              } finally {
                hook.mockRestore()
              }
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })

  test("session loop exposes only agent delegation catalog for default protocol runner", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-default-protocol"),
            fn: async () => {
              resetRegistry()
              const seen: { tools: number; system: string; prompt: string }[] = []
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process(stream: LLM.StreamInput) {
                    seen.push({ tools: Object.keys(stream.tools).length, system: stream.system.join("\n"), prompt: stream.runtimeTools?.prompt ?? "" })
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Default protocol agents test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "default",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: { read: true, glob: true, grep: true, bash: true },
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "analyze project",
                })

                await SessionPrompt.loop({ sessionID: session.id })

                expect(seen).toHaveLength(1)
                expect(seen[0]?.tools).toBe(0)
                expect(seen[0]?.system).not.toContain("Available Protocol Tools")
                expect(seen[0]?.prompt).toContain("Available Protocol Agents")
                expect(seen[0]?.prompt).not.toContain("Available Protocol Tools")
                expect(seen[0]?.prompt).not.toContain("## read")
                expect(seen[0]?.prompt).not.toContain("## bash")
                expect(seen[0]?.prompt).not.toContain("input_schema:")
                expect(seen[0]?.prompt).toContain('"type": "agent"')
                expect(seen[0]?.prompt).toContain("## frontend")
                await Session.remove(session.id)
              } finally {
                hook.mockRestore()
              }
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })

  test("session loop hides default from default protocol runner catalog", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-default-child-protocol"),
            fn: async () => {
              resetRegistry()
              const seen: { prompt: string }[] = []
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process(stream: LLM.StreamInput) {
                    seen.push({ prompt: stream.runtimeTools?.prompt ?? "" })
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const parent = await Session.create({ title: "Parent default protocol agents test" })
                const session = await Session.create({ parentID: parent.id, title: "Child default protocol agents test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "default",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "plan one layer",
                })

                await SessionPrompt.loop({ sessionID: session.id })

                expect(seen).toHaveLength(1)
                expect(seen[0]?.prompt).toContain("Available Protocol Agents")
                expect(seen[0]?.prompt).not.toContain("## default")
                expect(seen[0]?.prompt).toContain("## frontend")
                await Session.remove(session.id)
                await Session.remove(parent.id)
              } finally {
                hook.mockRestore()
              }
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })

  test("session loop does not show unavailable read examples for planner agents", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-feature-planner-tools"),
            fn: async () => {
              resetRegistry()
              const seen: { prompt: string }[] = []
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process(stream: LLM.StreamInput) {
                    seen.push({ prompt: stream.runtimeTools?.prompt ?? "" })
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Feature planner protocol tools test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "feature-planner",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "decompose one epic",
                })

                await SessionPrompt.loop({ sessionID: session.id })

                expect(seen).toHaveLength(1)
                expect(seen[0]?.prompt).toContain("## question")
                expect(seen[0]?.prompt).toContain("## explore")
                expect(seen[0]?.prompt).toContain('"name": "question"')
                expect(seen[0]?.prompt).not.toContain('"name": "read"')
                expect(seen[0]?.prompt).toContain("If repository read, search, command, edit, validation, or review tools are not listed")
                await Session.remove(session.id)
              } finally {
                hook.mockRestore()
              }
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})
