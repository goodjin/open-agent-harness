import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionProcessor } from "../../src/session/processor"
import { SessionLog } from "../../src/session/log"
import { SessionStatus } from "../../src/session/status"
import { LLM } from "../../src/session/llm"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider/provider"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  // @ts-expect-error Bun mock restore is present on spies
  LLM.stream.mockRestore?.()
})

describe("session.started event", () => {
  test("should emit session.started event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            let eventReceived = false
            let receivedInfo: Session.Info | undefined

            const unsub = Bus.subscribe(Session.Event.Created, (event) => {
              eventReceived = true
              receivedInfo = event.properties.info as Session.Info
            })

            const session = await Session.create({})

            await new Promise((resolve) => setTimeout(resolve, 100))

            unsub()

            expect(eventReceived).toBe(true)
            expect(receivedInfo).toBeDefined()
            expect(receivedInfo?.id).toBe(session.id)
            expect(receivedInfo?.projectID).toBe(session.projectID)
            expect(receivedInfo?.directory).toBe(session.directory)
            expect(receivedInfo?.title).toBe(session.title)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("session.started event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const events: string[] = []

            const unsubStarted = Bus.subscribe(Session.Event.Created, () => {
              events.push("started")
            })

            const unsubUpdated = Bus.subscribe(Session.Event.Updated, () => {
              events.push("updated")
            })

            const session = await Session.create({})

            await new Promise((resolve) => setTimeout(resolve, 100))

            unsubStarted()
            unsubUpdated()

            expect(events).toContain("started")
            expect(events).toContain("updated")
            expect(events.indexOf("started")).toBeLessThan(events.indexOf("updated"))

            await Session.remove(session.id)
          },
        }),
    })
  })
})

describe("session processor lifecycle", () => {
  test("propagates runtime errors after recording error status", async () => {
    const err = new Error("processor exploded")
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: "start" as const }
          yield { type: "reasoning-start" as const, id: "reasoning" }
          yield { type: "reasoning-delta" as const, id: "reasoning", text: "hidden thought" }
          yield { type: "reasoning-end" as const, id: "reasoning" }
          yield { type: "text-start" as const }
          yield { type: "text-delta" as const, text: "visible answer" }
          yield { type: "text-end" as const }
          yield { type: "error" as const, error: err }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const user = MessageID.ascending()
            const input = (await Session.updateMessage({
              id: user,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "test",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)) as MessageV2.User

            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              parentID: user,
              role: "assistant",
              mode: "test",
              agent: "test",
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
                cwd: projectRoot,
                root: projectRoot,
              },
              time: { created: Date.now() },
              sessionID: session.id,
            })) as MessageV2.Assistant

            const processor = SessionProcessor.create({
              assistantMessage: assistant,
              sessionID: session.id,
              model: {
                id: "test",
                providerID: "test",
                limit: { context: 100_000, output: 32_000 },
              } as Provider.Model,
              abort: new AbortController().signal,
            })

            await expect(
              processor.process({
                user: input,
                sessionID: session.id,
                model: {} as Provider.Model,
                agent: {
                  name: "test",
                  mode: "primary",
                  permission: [],
                  options: {},
                },
                system: ["system prompt"],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "hello prompt" }],
                tools: {},
              } as unknown as LLM.StreamInput),
            ).rejects.toBe(err)

            expect(SessionStatus.get(session.id)).toEqual({ type: "error", message: "Error: processor exploded" })
            const logs = await SessionLog.list({ sessionID: session.id })
            expect(logs.map((item) => item.type)).toEqual([
              "llm.start",
              "reasoning.start",
              "reasoning.end",
              "text.start",
              "text.end",
              "llm.error",
            ])
            expect(logs.find((item) => item.type === "llm.start")?.data).toMatchObject({
              request: {
                systemInputCount: 1,
                messageCount: 1,
                messageBytes: 42,
              },
            })
            expect(logs.find((item) => item.type === "reasoning.end")?.data).toMatchObject({
              text: "hidden thought",
            })
            expect(logs.find((item) => item.type === "text.end")?.data).toMatchObject({
              text: "visible answer",
            })
            const stored = await MessageV2.get({ sessionID: session.id, messageID: assistant.id })
            expect(stored.info.role).toBe("assistant")
            if (stored.info.role === "assistant") expect(stored.info.error).toBeDefined()

            SessionStatus.set(session.id, { type: "idle" })
            await Session.remove(session.id)
          },
        }),
    })

    stream.mockRestore()
  })

  test("stops repeated preflight compaction for the same user message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-preflight-limit"),
          fn: async () => {
            const session = await Session.create({})
            const user = MessageID.ascending()
            await Session.updateMessage({
              id: user,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "test",
              model: { providerID: "minimax-cn-coding-plan", modelID: "MiniMax-M3" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)

            for (const _ of [1, 2]) {
              await SessionLog.emit({
                sessionID: session.id,
                level: "warn",
                type: "llm.preflight_compact",
                data: { user },
              })
              await Session.updateMessage({
                id: MessageID.ascending(),
                parentID: user,
                role: "assistant",
                mode: "test",
                agent: "test",
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                modelID: ModelID.make("MiniMax-M3"),
                providerID: ProviderID.make("minimax-cn-coding-plan"),
                path: {
                  cwd: projectRoot,
                  root: projectRoot,
                },
                time: { created: Date.now() },
                sessionID: session.id,
              } as MessageV2.Assistant)
            }

            await Session.updateMessage({
              id: MessageID.ascending(),
              parentID: user,
              role: "assistant",
              mode: "test",
              agent: "test",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("MiniMax-M3"),
              providerID: ProviderID.make("minimax-cn-coding-plan"),
              path: {
                cwd: projectRoot,
                root: projectRoot,
              },
              time: { created: Date.now() },
              sessionID: session.id,
            } as MessageV2.Assistant)

            expect(await SessionProcessor.shouldStopCompact(session.id, user)).toBe(true)

            await Session.remove(session.id)
          },
        }),
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("test-workspace"),
            fn: async () => {
              const session = await Session.create({})

              const messageID = MessageID.ascending()
              await Session.updateMessage({
                id: messageID,
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "user",
                model: { providerID: "test", modelID: "test" },
                tools: {},
                mode: "",
              } as unknown as MessageV2.Info)

              let received: MessageV2.Part | undefined
              const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
                received = event.properties.part
              })

              const tokens = {
                total: 1500,
                input: 500,
                output: 800,
                reasoning: 200,
                cache: { read: 100, write: 50 },
              }

              const partInput = {
                id: PartID.ascending(),
                messageID,
                sessionID: session.id,
                type: "step-finish" as const,
                reason: "stop",
                cost: 0.005,
                tokens,
              }

              await Session.updatePart(partInput)

              await new Promise((resolve) => setTimeout(resolve, 100))

              expect(received).toBeDefined()
              expect(received!.type).toBe("step-finish")
              const finish = received as MessageV2.StepFinishPart
              expect(finish.tokens.input).toBe(500)
              expect(finish.tokens.output).toBe(800)
              expect(finish.tokens.reasoning).toBe(200)
              expect(finish.tokens.total).toBe(1500)
              expect(finish.tokens.cache.read).toBe(100)
              expect(finish.tokens.cache.write).toBe(50)
              expect(finish.cost).toBe(0.005)
              expect(received).not.toBe(partInput)

              unsub()
              await Session.remove(session.id)
            },
          }),
      })
    },
    { timeout: 30000 },
  )
})
