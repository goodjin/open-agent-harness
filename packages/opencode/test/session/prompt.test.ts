import path from "path"
import fs from "fs/promises"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { getRegistry, resetRegistry } from "../../src/agent/registry"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionLog } from "../../src/session/log"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Provider } from "../../src/provider/provider"

Log.init({ print: false })

afterEach(() => {
  // @ts-expect-error Bun mock restore is present on spies
  LLM.stream.mockRestore?.()
  // @ts-expect-error Bun mock restore is present on spies
  Provider.getModel.mockRestore?.()
})

async function agent(dir: string, id: string, cfg: Record<string, unknown> = {}) {
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
      ...cfg,
    }),
  )
  await Bun.write(path.join(root, "identity.md"), `# Identity\n\n${id} identity`)
  await Bun.write(path.join(root, "rules.md"), `# Rules\n\n${id} rules`)
}

describe("session.prompt missing file", () => {
  test("stops automatic overflow compaction after repeated attempts", () => {
    const item = (auto: boolean, overflow: boolean | undefined): MessageV2.WithParts =>
      ({
        info: {
          id: MessageID.ascending(),
          sessionID: "ses_test",
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: "ses_test",
            type: "compaction",
            auto,
            overflow,
          },
        ],
      }) as MessageV2.WithParts

    expect(SessionPrompt.shouldStopCompact({ overflow: true, messages: [item(true, true)] })).toBe(false)
    expect(SessionPrompt.shouldStopCompact({ overflow: true, messages: [item(false, true), item(true, true)] })).toBe(false)
    expect(SessionPrompt.shouldStopCompact({ overflow: true, messages: [item(true, true), item(true, true)] })).toBe(true)
    expect(SessionPrompt.shouldStopCompact({ overflow: false, messages: [item(true, true), item(true, true)] })).toBe(false)
  })

  test("records setup failures in the assistant message and session log", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const user = await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "build",
              model: { providerID: "openai", modelID: "gpt-5.2" },
              tools: {},
              mode: "",
              time: { created: Date.now() },
            } as unknown as MessageV2.Info)
            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              parentID: user.id,
              sessionID: session.id,
              role: "assistant",
              mode: "build",
              agent: "build",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              time: { created: Date.now() },
            })) as MessageV2.Assistant

            await SessionPrompt.failSetup({
              sessionID: session.id,
              assistant,
              providerID: ProviderID.make("openai"),
              error: new Error("setup exploded"),
              stage: "resolve_tools",
            })

            const msg = await MessageV2.get({ sessionID: session.id, messageID: assistant.id })
            expect(msg.info.role).toBe("assistant")
            if (msg.info.role !== "assistant") throw new Error("expected assistant message")
            expect(msg.info.error?.name).toBe("UnknownError")
            expect(msg.info.error?.data.message).toBe("Error: setup exploded")
            expect(typeof msg.info.time.completed).toBe("number")
            expect(SessionStatus.get(session.id).type).toBe("error")

            const logs = await SessionLog.list({ sessionID: session.id })
            expect(logs).toContainEqual(
              expect.objectContaining({
                type: "llm.error",
                data: expect.objectContaining({
                  stage: "resolve_tools",
                  error: "Error: setup exploded",
                  name: "UnknownError",
                }),
              }),
            )

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("loop marks completed after completed assistant message", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const user = MessageID.ascending()
            await Session.updateMessage({
              id: user,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)
            await Session.updateMessage({
              id: MessageID.ascending(),
              parentID: user,
              role: "assistant",
              mode: "build",
              agent: "build",
              finish: "stop",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("test"),
              providerID: ProviderID.make("test"),
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              time: { created: Date.now(), completed: Date.now() },
              sessionID: session.id,
            })

            const msg = await SessionPrompt.loop({ sessionID: session.id })
            expect(msg.info.role).toBe("assistant")
            expect(SessionStatus.get(session.id).type).toBe("completed")

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("loop skips legacy errored completed turns before processing newer user turns", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const old = MessageID.ascending()
            await Session.updateMessage({
              id: old,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)
            await Session.updateMessage({
              id: MessageID.ascending(),
              parentID: old,
              role: "assistant",
              mode: "build",
              agent: "build",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("deepseek-v4-flash"),
              providerID: ProviderID.make("deepseek"),
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              error: new MessageV2.APIError({
                message: "Insufficient Balance",
                isRetryable: false,
              }).toObject(),
              time: { created: Date.now(), completed: Date.now() },
              sessionID: session.id,
            } as unknown as MessageV2.Assistant)

            const user = MessageID.ascending()
            await Session.updateMessage({
              id: user,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)
            const assistant = MessageID.ascending()
            await Session.updateMessage({
              id: assistant,
              parentID: user,
              role: "assistant",
              mode: "build",
              agent: "build",
              finish: "stop",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("test"),
              providerID: ProviderID.make("test"),
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              time: { created: Date.now(), completed: Date.now() },
              sessionID: session.id,
            })

            const msg = await SessionPrompt.loop({ sessionID: session.id })
            expect(msg.info.id).toBe(assistant)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("loop uses session model before queued user message model", async () => {
    const seen: { providerID: string; modelID: string }[] = []
    spyOn(Provider, "getModel").mockImplementation(async (providerID, modelID) => {
      seen.push({ providerID, modelID })
      return {
        id: modelID,
        providerID,
        limit: { context: 100_000, output: 32_000 },
      } as Provider.Model
    })
    spyOn(LLM, "stream").mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: "start" as const }
        yield { type: "start-step" as const }
        yield { type: "text-start" as const }
        yield { type: "text-delta" as const, text: "ok" }
        yield { type: "text-end" as const }
        yield {
          type: "finish-step" as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
        yield { type: "finish" as const }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>)

    await using tmp = await tmpdir({ git: true })
    await agent(tmp.path, "build")

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            resetRegistry()
            const session = await Session.create({})
            await Session.setModel({
              sessionID: session.id,
              model: {
                providerID: ProviderID.make("minimax-cn-coding-plan"),
                modelID: ModelID.make("MiniMax-M3"),
              },
            })
            const user = MessageID.ascending()
            await Session.updateMessage({
              id: user,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: {
                providerID: ProviderID.make("deepseek"),
                modelID: ModelID.make("deepseek-v4-flash"),
              },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)

            const msg = await SessionPrompt.loop({ sessionID: session.id, messageID: user })
            expect(msg.info.role).toBe("assistant")
            if (msg.info.role !== "assistant") throw new Error("expected assistant message")
            expect(msg.info.providerID).toBe(ProviderID.make("minimax-cn-coding-plan"))
            expect(msg.info.modelID).toBe(ModelID.make("MiniMax-M3"))
            expect(seen).toContainEqual({
              providerID: ProviderID.make("minimax-cn-coding-plan"),
              modelID: ModelID.make("MiniMax-M3"),
            })
            expect(seen).not.toContainEqual({
              providerID: ProviderID.make("deepseek"),
              modelID: ModelID.make("deepseek-v4-flash"),
            })

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})

            const missing = path.join(tmp.path, "does-not-exist.ts")
            const msg = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                { type: "text", text: "please review @does-not-exist.ts" },
                {
                  type: "file",
                  mime: "text/plain",
                  url: `file://${missing}`,
                  filename: "does-not-exist.ts",
                },
              ],
            })

            if (msg.info.role !== "user") throw new Error("expected user message")

            const hasFailure = msg.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
            )
            expect(hasFailure).toBe(true)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})

            const missing = path.join(tmp.path, "still-missing.ts")
            const msg = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                {
                  type: "file",
                  mime: "text/plain",
                  url: `file://${missing}`,
                  filename: "still-missing.ts",
                },
                { type: "text", text: "after-file" },
              ],
            })

            if (msg.info.role !== "user") throw new Error("expected user message")

            const stored = await MessageV2.get({
              sessionID: session.id,
              messageID: msg.info.id,
            })
            const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

            expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
            expect(text[1]?.includes("Read tool failed to read")).toBe(true)
            expect(text[2]).toBe("after-file")

            await Session.remove(session.id)
          },
        }),
    })
  })
})

describe("session.prompt special characters", () => {
  test("only resolves mentionable agent references", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await agent(dir, "visible", {
          entry: {
            primary: false,
            delegable: true,
            mentionable: true,
            default: false,
            hidden: false,
          },
        })
        await agent(dir, "quiet", {
          entry: {
            primary: false,
            delegable: true,
            mentionable: false,
            default: false,
            hidden: false,
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            resetRegistry()
            const parts = await SessionPrompt.resolvePromptParts("Ask @visible and @quiet")

            expect(parts.filter((part) => part.type === "agent").map((part) => part.name)).toEqual(["visible"])
          },
        }),
    })
  })

  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const template = "Read @file#name.txt"
            const parts = await SessionPrompt.resolvePromptParts(template)
            const fileParts = parts.filter((part) => part.type === "file")

            expect(fileParts.length).toBe(1)
            expect(fileParts[0].filename).toBe("file#name.txt")
            expect(fileParts[0].url).toContain("%23")

            const decodedPath = fileURLToPath(fileParts[0].url)
            expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

            const message = await SessionPrompt.prompt({
              sessionID: session.id,
              parts,
              noReply: true,
            })
            const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
            const textParts = stored.parts.filter((part) => part.type === "text")
            const hasContent = textParts.some((part) => part.text.includes("special content"))
            expect(hasContent).toBe(true)

            await Session.remove(session.id)
          },
        }),
    })
  })
})

describe("session.prompt agent variant", () => {
  test("keeps explicit session model before agent variant model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace"),
            fn: async () => {
              const session = await Session.create({})

              const other = await SessionPrompt.prompt({
                sessionID: session.id,
                agent: "build",
                model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
                noReply: true,
                parts: [{ type: "text", text: "hello" }],
              })
              if (other.info.role !== "user") throw new Error("expected user message")
              expect(other.info.variant).toBeUndefined()

              const match = await SessionPrompt.prompt({
                sessionID: session.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "hello again" }],
              })
              if (match.info.role !== "user") throw new Error("expected user message")
              expect(match.info.model).toEqual({
                providerID: ProviderID.make("opencode"),
                modelID: ModelID.make("kimi-k2.5-free"),
              })
              expect(match.info.variant).toBeUndefined()

              const override = await SessionPrompt.prompt({
                sessionID: session.id,
                agent: "build",
                noReply: true,
                variant: "high",
                parts: [{ type: "text", text: "hello third" }],
              })
              if (override.info.role !== "user") throw new Error("expected user message")
              expect(override.info.variant).toBe("high")

              await Session.remove(session.id)
            },
          }),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.prompt agent switch", () => {
  test("uses session model preference when caller omits model", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            await Session.setModel({
              sessionID: session.id,
              model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            })

            const msg = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "service message" }],
            })
            if (msg.info.role !== "user") throw new Error("expected user message")
            expect(msg.info.model).toEqual({
              providerID: ProviderID.make("opencode"),
              modelID: ModelID.make("kimi-k2.5-free"),
            })

            const err = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-sonnet-4") },
              noReply: true,
              parts: [{ type: "text", text: "explicit model" }],
            }).catch((err) => err)
            expect((err as { data?: { message?: string } }).data?.message).toContain("kimi-k2.5-free")
            expect((await Session.get(session.id)).model).toEqual({
              providerID: ProviderID.make("opencode"),
              modelID: ModelID.make("kimi-k2.5-free"),
            })

            const explicit = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-sonnet-4") },
              confirm: true,
              noReply: true,
              parts: [{ type: "text", text: "explicit model" }],
            })
            if (explicit.info.role !== "user") throw new Error("expected user message")
            expect(explicit.info.model).toEqual({
              providerID: ProviderID.make("anthropic"),
              modelID: ModelID.make("claude-sonnet-4"),
            })
            expect((await Session.get(session.id)).model).toEqual({
              providerID: ProviderID.make("anthropic"),
              modelID: ModelID.make("claude-sonnet-4"),
            })

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("registry switch changes next prompt agent without dropping messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await agent(tmp.path, "build")
    await agent(tmp.path, "plan")

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            resetRegistry()
            const registry = getRegistry()
            const session = await Session.create({})

            expect((await registry.switch("build"))?.id).toBe("build")
            const first = await SessionPrompt.prompt({
              sessionID: session.id,
              noReply: true,
              parts: [{ type: "text", text: "first" }],
            })
            if (first.info.role !== "user") throw new Error("expected user message")
            expect(first.info.agent).toBe("build")

            expect((await registry.switch("plan"))?.id).toBe("plan")
            const second = await SessionPrompt.prompt({
              sessionID: session.id,
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
  })

  test("rejects prompt agent changes for bound sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await agent(tmp.path, "build")
    await agent(tmp.path, "plan")

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            await Session.setAgent({ sessionID: session.id, agent: "build" })

            const err = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "plan",
              noReply: true,
              parts: [{ type: "text", text: "wrong agent" }],
            }).catch((err) => err)
            expect((err as { data?: { message?: string } }).data?.message).toContain(
              "Update the session agent before sending",
            )

            const shell = await SessionPrompt.shell({
              sessionID: session.id,
              agent: "plan",
              command: "echo wrong-agent",
            }).catch((err) => err)
            expect((shell as { data?: { message?: string } }).data?.message).toContain(
              "Update the session agent before sending",
            )

            await Session.remove(session.id)
          },
        }),
    })
  })
})
