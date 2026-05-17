import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Session } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { LLM } from "../../src/session/llm"
import { MemoryStore } from "../../src/memory"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "../../src/provider/provider"
import type { Agent } from "../../src/agent/agent"

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

afterEach(() => {
  // @ts-expect-error Bun mock restore is present on spies
  LLM.stream.mockRestore?.()
  // @ts-expect-error Bun mock restore is present on spies
  MemoryStore.capture.mockRestore?.()
})

function model(): Provider.Model {
  return {
    id: "test",
    providerID: "test",
    name: "Test",
    limit: {
      context: 100_000,
      input: 100_000,
      output: 4_000,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: {
        text: true,
        image: false,
        audio: false,
        video: false,
      },
      output: {
        text: true,
        image: false,
        audio: false,
        video: false,
      },
    },
    api: {
      npm: "@ai-sdk/openai",
    },
    options: {},
  } as Provider.Model
}

describe("memory integration", () => {
  test("completion creates a memory candidate", async () => {
    spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: "start" as const }
          yield { type: "text-start" as const }
          yield { type: "text-delta" as const, text: "Remember semantic memory endpoint behavior." }
          yield { type: "text-end" as const }
          yield {
            type: "finish-step" as const,
            finishReason: "stop",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            },
          }
          yield { type: "finish" as const }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const user = (await Session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "default",
              model: {
                providerID: ProviderID.make("test"),
                modelID: ModelID.make("test"),
              },
              time: {
                created: Date.now(),
              },
            })) as MessageV2.User
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: session.id,
              type: "text",
              text: "Please remember semantic memory endpoint behavior.",
            })
            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              sessionID: session.id,
              parentID: user.id,
              mode: "default",
              agent: "default",
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
              modelID: ModelID.make("test"),
              providerID: ProviderID.make("test"),
              time: {
                created: Date.now(),
              },
            })) as MessageV2.Assistant
            const processor = SessionProcessor.create({
              assistantMessage: assistant,
              sessionID: session.id,
              model: model(),
              abort: new AbortController().signal,
            })

            await processor.process({
              user,
              sessionID: session.id,
              model: model(),
              agent: {
                name: "default",
                mode: "primary",
                entry: ent,
                capability: cap,
                permission: [],
                prompt: "",
                options: {},
              },
              system: [],
              abort: new AbortController().signal,
              messages: [],
              tools: {},
            })

            const memories = await MemoryStore.bySession(session.id)
            expect(memories.some((memory) => memory.text.includes("semantic memory endpoint"))).toBe(true)
          },
        }),
    })
  })

  test("capture failure does not fail completion", async () => {
    spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: "start" as const }
          yield { type: "text-start" as const }
          yield { type: "text-delta" as const, text: "Completion should survive memory failure." }
          yield { type: "text-end" as const }
          yield {
            type: "finish-step" as const,
            finishReason: "stop",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            },
          }
          yield { type: "finish" as const }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })
    spyOn(MemoryStore, "capture").mockImplementation(async () => {
      throw new Error("capture failed")
    })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const user = (await Session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "default",
              model: {
                providerID: ProviderID.make("test"),
                modelID: ModelID.make("test"),
              },
              time: {
                created: Date.now(),
              },
            })) as MessageV2.User
            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              sessionID: session.id,
              parentID: user.id,
              mode: "default",
              agent: "default",
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
              modelID: ModelID.make("test"),
              providerID: ProviderID.make("test"),
              time: {
                created: Date.now(),
              },
            })) as MessageV2.Assistant
            const processor = SessionProcessor.create({
              assistantMessage: assistant,
              sessionID: session.id,
              model: model(),
              abort: new AbortController().signal,
            })

            const result = await processor.process({
              user,
              sessionID: session.id,
              model: model(),
              agent: {
                name: "default",
                mode: "primary",
                entry: ent,
                capability: cap,
                permission: [],
                prompt: "",
                options: {},
              },
              system: [],
              abort: new AbortController().signal,
              messages: [],
              tools: {},
            })

            expect(result).toBe("continue")
          },
        }),
    })
  })
})
