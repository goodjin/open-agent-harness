import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { SessionRunner } from "../../src/session/runner"
import { LLM } from "../../src/session/llm"
import { WorkflowState } from "../../src/workflow/state"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { tmpdir } from "../fixture/fixture"

describe("SessionRunner", () => {
  test("selects chat for ordinary agents", () => {
    expect(SessionRunner.select({})).toBe("chat")
    expect(SessionRunner.select({ runner: "chat" })).toBe("chat")
  })

  test("selects workflow for workflow-runner agents", () => {
    expect(SessionRunner.select({ runner: "workflow" })).toBe("workflow")
  })

  test("dispatches ordinary agents to chat without changing chat result", () => {
    const seen: string[] = []
    const result = SessionRunner.dispatch(
      { agent: {} },
      {
        chat: () => {
          seen.push("chat")
          return "continue"
        },
        workflow: () => {
          seen.push("workflow")
          return "stop"
        },
      },
    )

    expect(result).toBe("continue")
    expect(seen).toEqual(["chat"])
  })

  test("dispatches workflow-runner agents to workflow", () => {
    const seen: string[] = []
    const result = SessionRunner.dispatch(
      { agent: { runner: "workflow" } },
      {
        chat: () => {
          seen.push("chat")
          return "continue"
        },
        workflow: () => {
          seen.push("workflow")
          return "continue"
        },
      },
    )

    expect(result).toBe("continue")
    expect(seen).toEqual(["workflow"])
  })

  test("workflow runner executes a workflow run instead of chat processing", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, ".opencode", "workflows"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "sample.json"),
      JSON.stringify({
        id: "sample",
        name: "Sample",
        steps: [{ id: "first", outputs: { first: "$input" } }, { id: "second", outputs: { second: "$first" } }],
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const user = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "workflow-runner",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              tools: {},
              mode: "",
            } as MessageV2.User)) as MessageV2.User
            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              parentID: user.id,
              role: "assistant",
              mode: "workflow-runner",
              agent: "workflow-runner",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              time: { created: Date.now() },
            })) as MessageV2.Assistant

            const runner = SessionRunner.create({
              assistantMessage: assistant,
              sessionID: session.id,
              model: {} as never,
              abort: new AbortController().signal,
            })
            const result = await runner.process({
              user,
              sessionID: session.id,
              model: {} as never,
              agent: {
                name: "workflow-runner",
                runner: "workflow",
              } as never,
              system: [],
              abort: new AbortController().signal,
              messages: [{ role: "user", content: "sample ship it" }],
              tools: {},
            })
            const state = WorkflowState.read((await Session.get(session.id)).dsl_context)
            const parts = await MessageV2.parts(assistant.id)

            expect(result).toBe("stop")
            expect(state?.status).toBe("completed")
            expect(state?.workflowID).toBe("sample")
            expect(state?.variables.second).toBe("sample ship it")
            expect(parts.some((part) => part.type === "text" && part.text.includes("completed"))).toBe(true)
            const part = parts.find((item) => item.type === "text") as MessageV2.TextPart | undefined
            expect(part?.metadata?.kind).toBe("workflow")
            expect(part?.metadata?.action).toBe("started")
          },
        }),
    })
  })

  test("workflow runner continues a stale active workflow run", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, ".opencode", "workflows"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "stale.json"),
      JSON.stringify({
        id: "stale",
        name: "Stale",
        steps: [{ id: "first", outputs: { first: "done" } }, { id: "second", outputs: { second: "$first" } }],
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: WorkflowState.write(undefined, {
                runID: "workflow_stale",
                workflowID: "stale",
                workflowName: "Stale",
                status: "active",
                current: "second",
                step: 1,
                total: 2,
                variables: { first: "done" },
                attempts: { first: 1 },
                completed: ["first"],
	                steps: [
	                  {
	                    id: "first",
	                    type: "task",
	                    agent: "auto",
	                    capabilities: [],
	                    mutates: false,
	                    inputs: {},
	                    outputs: { first: "done" },
	                    guards: [],
	                    depends_on: [],
	                  },
	                  {
	                    id: "second",
	                    type: "task",
	                    agent: "auto",
	                    capabilities: [],
	                    mutates: false,
	                    inputs: {},
                    outputs: { second: "$first" },
                    guards: [],
                    depends_on: ["first"],
                  },
                ],
                nodes: {
                  second: {
                    step: "second",
                    status: "running",
                    agent: "workflow-runner",
                    path: path.join(tmp.path, ".opencode", "workflows", "runs", "workflow_stale", "second.json"),
                    attempt: 1,
                    time: { started: Date.now(), updated: Date.now() },
                  },
                },
                statuses: { first: "completed", second: "running" },
                time: { started: Date.now(), updated: Date.now() },
              }),
            })
            const user = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "workflow-runner",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              tools: {},
              mode: "",
            } as MessageV2.User)) as MessageV2.User
            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              parentID: user.id,
              role: "assistant",
              mode: "workflow-runner",
              agent: "workflow-runner",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              time: { created: Date.now() },
            })) as MessageV2.Assistant

            const runner = SessionRunner.create({
              assistantMessage: assistant,
              sessionID: session.id,
              model: {} as never,
              abort: new AbortController().signal,
            })
            const result = await runner.process({
              user,
              sessionID: session.id,
              model: {} as never,
              agent: {
                name: "workflow-runner",
                runner: "workflow",
              } as never,
              system: [],
              abort: new AbortController().signal,
              messages: [{ role: "user", content: "继续推进" }],
              tools: {},
            })
            const state = WorkflowState.read((await Session.get(session.id)).dsl_context)
            const parts = await MessageV2.parts(assistant.id)

            expect(result).toBe("stop")
            expect(state?.status).toBe("completed")
            expect(state?.completed).toEqual(["first", "second"])
            expect(state?.variables.second).toBe("done")
            expect(parts.some((part) => part.type === "text" && part.text.includes("completed"))).toBe(true)
            const part = parts.find((item) => item.type === "text") as MessageV2.TextPart | undefined
            expect(part?.metadata?.kind).toBe("workflow")
            expect(part?.metadata?.action).toBe("continued")
          },
        }),
    })
  })

  test("workflow runner writes progress before waiting for active workflow", async () => {
    await using tmp = await tmpdir()
    let done!: (state: WorkflowState.Info) => void
    const wait = new Promise<WorkflowState.Info>((resolve) => {
      done = resolve
    })
    const hook = spyOn(WorkflowExecutor, "continueRun").mockImplementation(async () => wait)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const state: WorkflowState.Info = {
                runID: "workflow_waiting",
                workflowID: "waiting",
                workflowName: "Waiting",
                status: "active",
                current: "second",
                step: 1,
                total: 2,
                variables: { first: "done" },
                attempts: { first: 1 },
                completed: ["first"],
                steps: [
                  {
                    id: "first",
                    type: "task",
                    agent: "auto",
                    capabilities: [],
                    mutates: false,
                    inputs: {},
                    outputs: {},
                    guards: [],
                    depends_on: [],
                  },
                  {
                    id: "second",
                    type: "task",
                    agent: "auto",
                    capabilities: [],
                    mutates: false,
                    inputs: {},
                    outputs: {},
                    guards: [],
                    depends_on: ["first"],
                  },
                ],
                nodes: {},
                statuses: { first: "completed", second: "running" },
                time: { started: Date.now(), updated: Date.now() },
              }
              const session = await Session.create({})
              await Session.setDslContext({
                sessionID: session.id,
                dsl_context: WorkflowState.write(undefined, state),
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "workflow-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "workflow-runner",
                agent: "workflow-runner",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              const runner = SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model: {} as never,
                abort: new AbortController().signal,
              })
              const pending = runner.process({
                user,
                sessionID: session.id,
                model: {} as never,
                agent: {
                  name: "workflow-runner",
                  runner: "workflow",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "继续推进" }],
                tools: {},
              })

              await Bun.sleep(10)
              const before = await MessageV2.parts(assistant.id)
              expect(before).toHaveLength(1)
              expect(before[0]?.type).toBe("text")
              expect(before[0]?.type === "text" && before[0].text.includes("active")).toBe(true)
              expect((before[0] as MessageV2.TextPart).metadata?.kind).toBe("workflow")
              expect((before[0] as MessageV2.TextPart).metadata?.action).toBe("continued")

              done({
                ...state,
                status: "completed",
                completed: ["first", "second"],
                statuses: { first: "completed", second: "completed" },
                time: { ...state.time, completed: Date.now() },
              })

              expect(await pending).toBe("stop")
              const after = await MessageV2.parts(assistant.id)
              expect(after).toHaveLength(1)
              expect(after[0]?.type === "text" && after[0].text.includes("completed")).toBe(true)
              expect((after[0] as MessageV2.TextPart).metadata?.kind).toBe("workflow")
              expect((after[0] as MessageV2.TextPart).metadata?.action).toBe("continued")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("workflow runner persists and runs workflow returned by chat", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      id: "generated",
      name: "Generated",
      steps: [{ id: "review", outputs: { reviewed: "$input" } }],
    }
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: `\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` }
          yield { type: "text-end" }
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "workflow-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "workflow-runner",
                agent: "workflow-runner",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              const runner = SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              })
              const result = await runner.process({
                user,
                sessionID: session.id,
                model,
                agent: {
                  name: "workflow-runner",
                  runner: "workflow",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "review toolbar buttons" }],
                tools: {},
              })
              const state = WorkflowState.read((await Session.get(session.id)).dsl_context)

              expect(result).toBe("stop")
              expect(await Bun.file(path.join(tmp.path, ".opencode", "workflows", "generated.json")).exists()).toBe(true)
              expect(state?.workflowID).toBe("generated")
              expect(state?.variables.reviewed).toBe("review toolbar buttons")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })
})
