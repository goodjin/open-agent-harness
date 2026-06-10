import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
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
import { LLM } from "../../src/session/llm"
import { resetRegistry } from "../../src/agent/registry"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { SessionLog } from "../../src/session/log"
import { Storage } from "../../src/storage/storage"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

describe("SessionPrompt runner wiring", () => {
  async function agent(dir: string, id: string, extra: Record<string, unknown>) {
    const root = path.join(dir, ".opencode", "agents", id)
    await fs.mkdir(root, { recursive: true })
    await Bun.write(
      path.join(root, "meta.json"),
      JSON.stringify({
        id,
        name: id,
        role: `${id} role`,
        description: `${id} agent`,
        model_preference: {
          providerID: "openai",
          modelID: "gpt-5.2",
        },
        runner: "chat",
        ...extra,
      }),
    )
    await Bun.write(path.join(root, "identity.md"), `# Identity\n\n${id} identity`)
    await Bun.write(path.join(root, "rules.md"), `# Rules\n\n${id} rules`)
  }

  test("session loop injects resolved agent instructions after legacy prompt", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await agent(dir, "coder", {
            instructions: {
              files: [
                { path: "guide.md", required: true },
                { path: "missing.md", required: false },
              ],
            },
          })
          await Bun.write(path.join(dir, ".opencode", "agents", "coder", "guide.md"), "agent guide")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-agent-instructions"),
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
                    seen.push(LLM.compose({ ...stream, isCodex: false })[0] ?? "")
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Agent instruction prompt test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "coder",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                  system: "assignment constraint",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "write code",
                })

                await SessionPrompt.loop({ sessionID: session.id })

                expect(seen).toHaveLength(1)
                expect(seen[0]).toContain("<agent-instruction>")
                expect(seen[0]).toContain("Source: guide.md")
                expect(seen[0]).toContain("Resolved path:")
                expect(seen[0]).toContain(path.join(tmp.path, ".opencode", "agents", "coder", "guide.md"))
                expect(seen[0]).toContain("agent guide")
                expect(seen[0]).not.toContain("missing.md")
                expect(seen[0].indexOf("# Rules")).toBeLessThan(seen[0].indexOf("<agent-instruction>"))
                expect(seen[0].indexOf("<agent-instruction>")).toBeLessThan(seen[0].indexOf("assignment constraint"))
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

  test("session loop prefers bound session agent over last user agent", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await agent(dir, "bound-worker", {
            kind: "worker",
          })
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-bound-agent"),
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
                    seen.push(stream.agent.name)
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Bound agent loop test" })
                await Session.setAgent({ sessionID: session.id, agent: "bound-worker" })
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
                  text: "continue delegated work",
                })

                await SessionPrompt.loop({ sessionID: session.id })

                expect(seen).toEqual(["bound-worker"])
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

  test("session loop fails setup when required agent instruction is missing", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await agent(dir, "coder", {
            instructions: {
              files: [{ path: "missing.md", required: true }],
            },
          })
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-agent-required-instruction"),
            fn: async () => {
              resetRegistry()
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process() {
                    throw new Error("runner should not start")
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Required instruction setup failure test" })
                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "coder",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "write code",
                })

                const msg = await SessionPrompt.loop({ sessionID: session.id })

                expect(hook).toHaveBeenCalledTimes(1)
                expect(msg.info.role).toBe("assistant")
                if (msg.info.role !== "assistant") throw new Error("expected assistant message")
                expect(msg.info.error?.data.message).toContain("Required instruction file is missing")
                const logs = await SessionLog.list({ sessionID: session.id })
                expect(logs).toContainEqual(
                  expect.objectContaining({
                    type: "llm.error",
                    data: expect.objectContaining({
                      stage: "resolve_instructions",
                      error: expect.stringContaining("Required instruction file is missing"),
                    }),
                  }),
                )
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

  test("session loop stops after repeated automatic overflow compactions", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await agent(dir, "coder", { runner: "chat" })
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-compact-limit"),
            fn: async () => {
              resetRegistry()
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process() {
                    return "compact"
                  },
                } as unknown as SessionRunner.Info
              })

              try {
                const session = await Session.create({ title: "Compact limit test" })
                for (const _ of [1, 2]) {
                  const msg = MessageID.ascending()
                  await Session.updateMessage({
                    id: msg,
                    sessionID: session.id,
                    role: "user",
                    time: { created: Date.now() },
                    agent: "coder",
                    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  } as MessageV2.User)
                  await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: msg,
                    sessionID: session.id,
                    type: "compaction",
                    auto: true,
                    overflow: true,
                  })
                  await Session.updateMessage({
                    id: MessageID.ascending(),
                    parentID: msg,
                    sessionID: session.id,
                    role: "assistant",
                    mode: "compaction",
                    agent: "compaction",
                    finish: "stop",
                    cost: 0,
                    tokens: {
                      input: 0,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    modelID: ModelID.make("gpt-5.2"),
                    providerID: ProviderID.make("openai"),
                    path: { cwd: tmp.path, root: tmp.path },
                    time: { created: Date.now(), completed: Date.now() },
                  } as MessageV2.Assistant)
                }

                const user = MessageID.ascending()
                await Session.updateMessage({
                  id: user,
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "coder",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                } as MessageV2.User)
                await Session.updatePart({
                  id: PartID.ascending(),
                  messageID: user,
                  sessionID: session.id,
                  type: "text",
                  text: "continue",
                })

                const msg = await SessionPrompt.loop({ sessionID: session.id })

                expect(hook).toHaveBeenCalledTimes(1)
                expect(msg.info.role).toBe("assistant")
                if (msg.info.role !== "assistant") throw new Error("expected assistant message")
                expect(msg.info.error?.name).toBe("ContextOverflowError")
                expect(msg.info.error?.data.message).toContain("Start a new session")
                const all = await MessageV2.filterCompacted(MessageV2.stream(session.id))
                const count = all
                  .flatMap((item) => item.parts)
                  .filter((part) => part.type === "compaction" && part.auto && part.overflow).length
                expect(count).toBe(2)
                const logs = await SessionLog.list({ sessionID: session.id })
                expect(logs).toContainEqual(expect.objectContaining({ type: "llm.compact_limit" }))
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

  test("session loop exposes delegation status and agent catalog for default protocol runner", async () => {
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
                expect(seen[0]?.prompt).toContain("Available Protocol Tools")
                expect(seen[0]?.prompt).toContain("## delegation_status")
                expect(seen[0]?.prompt).not.toContain("## read")
                expect(seen[0]?.prompt).not.toContain("## bash")
                expect(seen[0]?.prompt).toContain("input_schema:")
                expect(seen[0]?.prompt).toContain('items[].kind: "agent"')
                expect(seen[0]?.prompt).toContain('"kind": "tool"')
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

  test("session loop stores matching protocol prompt cache outside dsl context", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-protocol-runtime-context"),
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
                    seen.push(stream.runtimeTools?.prompt ?? "")
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              const session = await Session.create({ title: "Protocol runtime context test" })
              try {
                await Session.setDslContext({
                  sessionID: session.id,
                  dsl_context: {
                    protocol: {
                      tools: {
                        prompt: "legacy stable protocol prompt",
                        catalog: ["read"],
                      },
                      pending_delegations: {},
                    },
                  },
                })
                for (const text of ["analyze project", "continue"]) {
                  const user = MessageID.ascending()
                  await Session.updateMessage({
                    id: user,
                    sessionID: session.id,
                    role: "user",
                    time: { created: Date.now() },
                    agent: "protocol-runner",
                    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                    tools: { read: true },
                    mode: "",
                  } as MessageV2.User)
                  await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: user,
                    sessionID: session.id,
                    type: "text",
                    text,
                  })
                  await SessionPrompt.loop({ sessionID: session.id })
                }

                const ctx = (await Session.get(session.id)).dsl_context as {
                  protocol?: { tools?: unknown; pending_delegations?: unknown }
                } | undefined
                const saved = await Storage.read<{
                  protocol?: { agent?: string; prompt?: string; catalog?: string[]; signature?: string }
                }>(["session_runtime_context", session.id])

                expect(seen).toHaveLength(2)
                expect(seen[0]).toBe(seen[1])
                expect(seen[0]).not.toBe("legacy stable protocol prompt")
                expect(ctx?.protocol?.tools).toBeUndefined()
                expect(ctx?.protocol?.pending_delegations).toEqual({})
                expect(saved.protocol?.agent).toBe("protocol-runner")
                expect(saved.protocol?.prompt).toBe(seen[0])
                expect(saved.protocol?.catalog).toContain("read")
                expect(saved.protocol?.signature).toContain("protocol-runner")
              } finally {
                hook.mockRestore()
                await Storage.remove(["session_runtime_context", session.id])
                await Session.remove(session.id)
              }
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })

  test("session loop rebuilds protocol prompt cache when agent changes", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await Instance.provide({
        directory: root,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace-protocol-agent-cache"),
            fn: async () => {
              resetRegistry()
              const seen: { agent: string; prompt: string }[] = []
              const hook = spyOn(SessionRunner, "create").mockImplementation((input) => {
                return {
                  get message() {
                    return input.assistantMessage
                  },
                  partFromToolCall() {
                    return undefined
                  },
                  async process(stream: LLM.StreamInput) {
                    seen.push({ agent: stream.agent.name, prompt: stream.runtimeTools?.prompt ?? "" })
                    input.assistantMessage.finish = "stop"
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  },
                } as unknown as SessionRunner.Info
              })

              const session = await Session.create({ title: "Protocol agent cache test" })
              try {
                for (const name of ["protocol-runner", "default"]) {
                  const user = MessageID.ascending()
                  await Session.updateMessage({
                    id: user,
                    sessionID: session.id,
                    role: "user",
                    time: { created: Date.now() },
                    agent: name,
                    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                    tools: {},
                    mode: "",
                  } as MessageV2.User)
                  await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: user,
                    sessionID: session.id,
                    type: "text",
                    text: `continue as ${name}`,
                  })
                  await SessionPrompt.loop({ sessionID: session.id })
                }

                const saved = await Storage.read<{
                  protocol?: { agent?: string; prompt?: string; catalog?: string[]; signature?: string }
                }>(["session_runtime_context", session.id])

                expect(seen.map((item) => item.agent)).toEqual(["protocol-runner", "default"])
                expect(seen[0]?.prompt).not.toBe(seen[1]?.prompt)
                expect(saved.protocol?.agent).toBe("default")
                expect(saved.protocol?.prompt).toBe(seen[1]?.prompt)
                expect(saved.protocol?.signature).toContain("default")
              } finally {
                hook.mockRestore()
                await Storage.remove(["session_runtime_context", session.id])
                await Session.remove(session.id)
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

  test("session loop exposes read tools for planner agents", async () => {
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
                expect(seen[0]?.prompt).toContain("## read")
                expect(seen[0]?.prompt).toContain("## grep")
                expect(seen[0]?.prompt).not.toContain("## edit")
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
