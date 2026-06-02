import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionRunner } from "../../src/session/runner"
import { SessionLog } from "../../src/session/log"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
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

  test("selects protocol for protocol-runner agents", () => {
    expect(SessionRunner.select({ runner: "protocol" })).toBe("protocol")
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

  test("dispatches protocol-runner agents to protocol", () => {
    const seen: string[] = []
    const result = SessionRunner.dispatch(
      { agent: { runner: "protocol" } },
      {
        chat: () => {
          seen.push("chat")
          return "chat"
        },
        workflow: () => {
          seen.push("workflow")
          return "workflow"
        },
        protocol: () => {
          seen.push("protocol")
          return "protocol"
        },
      },
    )

    expect(result).toBe("protocol")
    expect(seen).toEqual(["protocol"])
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
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      id: "generated",
      name: "Generated",
      steps: [{ id: "review", outputs: { reviewed: "$input" } }],
    }
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      inputs.push(input)
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Final answer from protocol result." }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
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
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
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

  test("protocol runner executes protocol blocks and projects run state", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Inspect",
      execution: { strategy: "sequential" },
      payload: {
        type: "action_graph",
        actions: [
          {
            type: "action",
            id: "inspect",
            title: "Inspect files",
            operation: "search",
            executor: { type: "tool", target: "grep" },
            input: { pattern: "protocol", include: "*.md" },
            prompt_ref: "md:inspect",
          },
          {
            type: "action",
            id: "delegate",
            title: "Delegate summary",
            operation: "general",
            executor: { type: "agent", target: "auto", capabilities: ["general"] },
            depends_on: ["inspect"],
          },
          {
            type: "action",
            id: "read",
            title: "Read target file",
            operation: "read",
            executor: { type: "tool", target: "read" },
            input: { filePath: "docs/protocol-target.md" },
            prompt_ref: "docs/protocol-target.md",
          },
        ],
      },
    }
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify({
                  type: "agent.protocol.output",
                  version: "1",
                  intent: "respond",
                  title: "Answer",
                  payload: { type: "message" },
                  response_ref: "md:response",
                }),
                "```",
                "",
                "## response",
                "Final answer from protocol result.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: `\`\`\`json agent-protocol\n${JSON.stringify(data)}\n\`\`\`\n\n## inspect\npattern: protocol\ninclude: *.md` }
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "default",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const assistant = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "default",
        agent: input.agent ?? "default",
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
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: "agent:default child summary",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)

    try {
      await fs.mkdir(path.join(tmp.path, "docs"), { recursive: true })
      await Bun.write(path.join(tmp.path, "docs", "protocol-target.md"), "protocol target")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [
                  { role: "user", content: "old turn" },
                  { role: "assistant", content: "[TOOL_CALL]\n{tool => \"read\"}\n[/TOOL_CALL]" },
                  { role: "user", content: "inspect" },
                ],
                tools: {},
              })
              const parts = await MessageV2.parts(assistant.id)
              const messages = await Session.messages({ sessionID: session.id })
              const final = messages.find(
                (item) => item.info.role === "assistant" && item.info.id !== assistant.id,
              )
              const finalParts = final ? await MessageV2.parts(final.info.id) : []
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { runID: string; total: number; actions: { id: string; status: string; output?: string }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_context" && part.ignored)).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.text.includes("agent-protocol") && !part.ignored)).toBe(false)
              expect(parts.some((part) => part.type === "tool" && part.metadata?.protocol === true)).toBe(true)
              expect(finalParts.some((part) => part.type === "text" && part.text.includes("Final answer"))).toBe(false)
              expect(calls).toBe(1)
              expect(protocol?.runs?.[0]?.total).toBe(3)
              expect(protocol?.runs?.[0]?.actions.find((item) => item.id === "delegate")?.output).toContain("The parent session will resume automatically")
              expect(protocol?.runs?.[0]?.actions.find((item) => item.id === "read")?.output).toContain("protocol target")
            },
          }),
      })
    } finally {
      hook.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner executes native AgentProtocolOutput tool calls", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      kind: "act",
      message: "Protocol violation recovered: direct read was converted.",
      calls: [
        {
          id: "read_package",
          type: "tool",
          name: "read",
          args: { filePath: "package.json" },
          result: "summary",
        },
      ],
    }
    const reply = {
      kind: "answer",
      message: "Read package successfully.",
    }
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      const input = calls === 1 ? { input: JSON.stringify(data) } : reply
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_protocol_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input,
            output: {
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            },
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })

    try {
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ name: "native-protocol" }))
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "read package" }],
                tools: {},
              })
              const messages = await Session.messages({ sessionID: session.id })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { output?: string; tool_call_ids: string[] }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions[0]?.output).toContain("native-protocol")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Protocol violation recovered")))).toBe(true)
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Read package successfully.")))).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner executes agent calls in child sessions", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      kind: "act",
      message: "Delegate review.",
      calls: [
        {
          id: "review_toolbar_buttons",
          type: "tool",
          name: "task",
          args: { description: "Review toolbar button handlers", prompt: "Review toolbar button handlers", subagent_type: "code-review" },
          result: "summary",
        },
      ],
    }
    let calls = 0
    const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Delegated review completed." }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: "call_protocol", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: "call_protocol",
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
          }
          yield {
            type: "tool-result",
            toolCallId: "call_protocol",
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
            output: {
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            },
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      inputs.push(input)
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "default",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.parts?.[0]?.type === "text" ? input.parts[0].text : "",
      } as MessageV2.TextPart)
      const assistant = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "default",
        agent: input.agent ?? "default",
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
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: "Child agent reviewed toolbar buttons.",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "delegate review" }],
                tools: {},
              })
              const children = await Session.children(session.id)
              const after = await Session.get(session.id)
              const protocol = after.dsl_context?.protocol as {
                runs?: { actions: { output?: string }[] }[]
              } | undefined
              const parts = await MessageV2.parts(assistant.id)

              expect(result).toBe("stop")
              expect(children).toHaveLength(1)
              expect(children[0]?.parentID).toBe(session.id)
              expect(children[0]?.title).toContain("Protocol: review_toolbar_buttons")
              const child = await Session.get(children[0]!.id)
              expect(JSON.stringify(child.dsl_context)).toContain("agent.delegation.assignment")
              expect(JSON.stringify(child.dsl_context)).toContain('"parent_session_id"')
              expect(JSON.stringify(protocol?.runs?.[0]?.actions[0])).toContain("The parent session will resume automatically")
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_summary" && part.text.includes("The parent session will resume automatically"))).toBe(true)
              await Bun.sleep(10)
              expect(inputs[0]?.agent).toBe("default")
              expect(inputs[1]?.agent).toBe("protocol-runner")
              expect(inputs[1]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(true)
              expect(inputs[1]?.parts?.some((part) => part.type === "text" && part.text.includes('"action_id": "review_toolbar_buttons"'))).toBe(true)
              expect(inputs[0]?.parts?.some((part) => part.type === "agent")).toBe(false)
              const text = inputs[0]?.parts?.map((part) => part.type === "text" ? part.text : "").join("\n")
              expect(text).not.toContain("<agent-protocol-call>")
              expect(text).not.toContain("@default")
              expect(text).not.toContain("call the task tool")
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
              expect(logs.some((item) => item.type === "protocol.agent.started")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.agent.completed")).toBe(true)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner completes parent assignment after nested child final", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      kind: "answer",
      message: "Child final answer after nested delegation.",
    }
    const stream = spyOn(LLM, "stream").mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: "start" }
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: "call_protocol", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
        yield {
          type: "tool-call",
          toolCallId: "call_protocol",
          toolName: LLM.PROTOCOL_OUTPUT_TOOL,
          input: data,
        }
        yield {
          type: "tool-result",
          toolCallId: "call_protocol",
          toolName: LLM.PROTOCOL_OUTPUT_TOOL,
          input: data,
          output: {
            output: "Agent Protocol package received.",
            title: "Agent Protocol Output",
            metadata: { protocol: true },
          },
        }
        yield {
          type: "finish-step",
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
        yield { type: "finish" }
      })(),
    }) as never)
    const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      inputs.push(input)
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "default",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const assistant = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "default",
        agent: input.agent ?? "default",
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
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: "Parent resumed from child result.",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({})
              const child = await Session.create({ parentID: parent.id })
              const parentMsg = MessageID.ascending()
              await Session.setDslContext({
                sessionID: child.id,
                dsl_context: {
                  protocol: {
                    delegation: {
                      type: "agent.delegation.assignment",
                      version: "1",
                      run_id: "apr_parent",
                      action_id: "child_task",
                      action_title: "Child task",
                      parent_session_id: parent.id,
                      parent_message_id: parentMsg,
                      parent_agent: "protocol-runner",
                      child_session_id: child.id,
                      agent: "protocol-runner",
                      result_policy: "summary",
                      created_at: Date.now(),
                    },
                  },
                },
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
              const result = await SessionRunner.create({
                assistantMessage: assistant,
                sessionID: child.id,
                model,
                abort: new AbortController().signal,
              }).process({
                user,
                sessionID: child.id,
                model,
                agent: {
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "continue from grandchild" }],
                tools: {},
              })
              const ctx = (await Session.get(child.id)).dsl_context

              expect(result).toBe("stop")
              expect(inputs).toHaveLength(1)
              expect(inputs[0]?.sessionID).toBe(parent.id)
              expect(inputs[0]?.agent).toBe("protocol-runner")
              expect(inputs[0]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(true)
              expect(inputs[0]?.parts?.some((part) => part.type === "text" && part.text.includes("Child final answer after nested delegation."))).toBe(true)
              expect(JSON.stringify(ctx)).toContain('"status":"completed"')
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner accepts plain markdown final responses", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      title: "Read package",
      actions: [
        {
          type: "action",
          id: "read_package",
          title: "Read package",
          operation: "read",
          executor: { type: "tool", target: "read", capabilities: ["repo"] },
          input: { filePath: "package.json" },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        },
      ],
    }
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      inputs.push(input)
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Plain final answer." }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: "call_protocol", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: "call_protocol",
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
          }
          yield {
            type: "tool-result",
            toolCallId: "call_protocol",
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
            output: {
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            },
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })

    try {
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ name: "plain-final" }))
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
              await runner.process({
                user,
                sessionID: session.id,
                model,
                agent: {
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "read package" }],
                tools: {},
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(calls).toBe(2)
              expect(inputs[1]?.toolChoice).toBeUndefined()
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Plain final answer.")))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.plain")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(false)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner accepts plain markdown follow-up answers after protocol work", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: "所有 Phase 1-4 的实现任务已完成。" }
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
              await Session.setDslContext({
                sessionID: session.id,
                dsl_context: {
                  protocol: {
                    runs: [{ run_id: "apr_done", status: "completed", actions: [] }],
                  },
                },
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "所有任务都完成了吗？" }],
                tools: {},
              })
              const parts = await MessageV2.parts(assistant.id)
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(1)
              expect(parts.some((part) => part.type === "text" && part.text.includes("Phase 1-4") && !part.ignored)).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_malformed")).toBe(false)
              expect(logs.some((item) => item.type === "protocol.final.plain")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(false)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner warns once and stops repeated final execution loops", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      kind: "act",
      message: "Read package again.",
      calls: [
        {
          id: "read_package",
          type: "tool",
          name: "read",
          args: { filePath: "package.json" },
          result: "summary",
        },
      ],
    }
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_protocol_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
            output: {
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            },
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })

    try {
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ name: "loop-guard" }))
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "read package" }],
                tools: {},
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(inputs[2]?.system.join("\n")).toContain("Loop warning")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_loop_guard"))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.loop_guard.triggered")).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner allows different final execution followups", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const first = {
      kind: "act",
      message: "Read package.",
      calls: [
        {
          id: "read_package",
          type: "tool",
          name: "read",
          args: { filePath: "package.json" },
          result: "summary",
        },
      ],
    }
    const next = {
      kind: "act",
      message: "Find TypeScript configs.",
      calls: [
        {
          id: "find_tsconfig",
          type: "tool",
          name: "glob",
          args: { pattern: "tsconfig*.json" },
          result: "summary",
        },
      ],
    }
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 3) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Checked package and TypeScript config." }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      const data = calls === 1 ? first : next
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_protocol_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data,
            output: {
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            },
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })

    try {
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ name: "followup" }))
      await Bun.write(path.join(tmp.path, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "check config" }],
                tools: {},
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Checked package and TypeScript config.")))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.loop_guard.triggered")).toBe(false)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner raises soft limit instead of stopping distinct followups", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = Array.from({ length: 7 }, (_, i) => ({
      kind: "act",
      message: `Read file ${i}.`,
      calls: [
        {
          id: `read_${i}`,
          type: "tool",
          name: "read",
          args: { filePath: `file-${i}.txt` },
          result: "summary",
        },
      ],
    }))
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      inputs.push(input)
      calls++
      if (calls === 8) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Diagnosis: still missing the exact selector. Next step: inspect the rendered DOM once." }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_protocol_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data[calls - 1],
          }
          yield {
            type: "tool-result",
            toolCallId: `call_protocol_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: data[calls - 1],
            output: {
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            },
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
          yield { type: "finish" }
        })(),
      } as never
    })

    try {
      await Promise.all(data.map((item, i) => Bun.write(path.join(tmp.path, `file-${i}.txt`), item.message)))
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "inspect several files" }],
                tools: {},
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(8)
              expect(inputs[7]?.system.join("\n")).toContain("Soft runtime limit reached")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Diagnosis: still missing")))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.loop_guard.triggered")).toBe(false)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner blocks vague tool auto searches instead of guessing files", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Review buttons",
      execution: { strategy: "sequential" },
      payload: {
        type: "action_graph",
        actions: [
          {
            type: "action",
            id: "inspect_project",
            title: "Inspect project",
            operation: "search",
            executor: { type: "tool", target: "auto", capabilities: ["repo"] },
            prompt_ref: "md:inspect",
          },
          {
            type: "action",
            id: "find_plugin_files",
            title: "Find plugin files",
            operation: "search",
            executor: { type: "tool", target: "auto", capabilities: ["repo"] },
            depends_on: ["inspect_project"],
            context_refs: ["inspect_project"],
            prompt_ref: "md:plugin",
          },
        ],
      },
    }
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield {
            type: "text-delta",
            text: [
              "```json agent-protocol",
              JSON.stringify(data),
              "```",
              "",
              "## inspect",
              "检查项目根目录结构，了解项目类型和整体架构。",
              "",
              "## plugin",
              "搜索项目中与插件（plugin）相关的文件，特别关注按钮点击事件处理代码。",
            ].join("\n"),
          }
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
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "review broken toolbar buttons" }],
                tools: {},
              })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { error?: string; output?: string; tool_call_ids: string[] }[] }[]
              } | undefined
              const error = protocol?.runs?.[0]?.actions.map((item) => item.error).join("\n") ?? ""

              expect(result).toBe("stop")
              expect(calls).toBe(1)
              expect(protocol?.runs?.[0]?.status).toBe("blocked")
              expect(error).toContain("concrete tool id")
              expect(error).not.toContain("package.json")
              expect(error).not.toContain("Toolbar.vue")
              expect(protocol?.runs?.[0]?.actions[0]?.tool_call_ids.length).toBe(0)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner recovers textual tool-call output instead of stopping", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      title: "Recover textual tool request",
      execution: { strategy: "sequential" },
      payload: {
        type: "action_graph",
        actions: [
          {
            type: "action",
            id: "find-html",
            title: "Find html files",
            operation: "inspect",
            executor: { type: "tool", target: "glob", capabilities: ["repo"] },
            input: { pattern: "*.html" },
            prompt_ref: "md:find-html",
            result_policy: "summary",
          },
          {
            type: "action",
            id: "find-js",
            title: "Find js files",
            operation: "inspect",
            executor: { type: "tool", target: "glob", capabilities: ["repo"] },
            input: { pattern: "*.js" },
            prompt_ref: "md:find-js",
            result_policy: "summary",
          },
        ],
      },
    }
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      if (calls === 3) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify({
                  type: "agent.protocol.output",
                  version: "1",
                  intent: "respond",
                  title: "Answer",
                  payload: { type: "message" },
                  response_ref: "md:response",
                }),
                "```",
                "",
                "## response",
                "Recovered final answer.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify(data),
                "```",
                "",
                "## find-html",
                "Find HTML files.",
                "",
                "## find-js",
                "Find JavaScript files.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: "我来检查项目。 minimax:tool_call /*.html /*.js" }
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
      await Bun.write(path.join(tmp.path, "index.html"), "<button>Save</button>")
      await Bun.write(path.join(tmp.path, "app.js"), "document.querySelector('button')")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "review broken buttons" }],
                tools: {},
              })
              const parts = await MessageV2.parts(assistant.id)
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { total: number; actions: { output?: string }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored)).toBe(true)
              expect(protocol?.runs?.[0]?.total).toBe(2)
              expect(protocol?.runs?.[0]?.actions.map((item) => item.output).join("\n")).toContain("index.html")
              expect(protocol?.runs?.[0]?.actions.map((item) => item.output).join("\n")).toContain("app.js")
              expect(JSON.stringify(inputs[1]?.system)).toContain("previous response violated")
              expect(JSON.stringify(inputs[2]?.messages)).toContain("Assistant protocol request and runtime results")
              expect(JSON.stringify(inputs[2]?.messages)).toContain("tool glob <<'JSON'")
              expect(JSON.stringify(inputs[2]?.messages)).toContain("Result for find-html")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner recovers xml glob tool calls with input", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "<minimax:tool_call>",
                '<invoke name="glob">',
                "<parameter name=\"pattern\">**/*.vsix</parameter>",
                `<parameter name="path">${tmp.path}</parameter>`,
                "</invoke>",
                "</minimax:tool_call>",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      if (calls === 3) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify({
                  type: "agent.protocol.output",
                  version: "1",
                  intent: "respond",
                  title: "Answer",
                  payload: { type: "message" },
                  response_ref: "md:response",
                }),
                "```",
                "",
                "## response",
                "Found package artifact.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: "I need to find the package artifact. minimax:tool_call" }
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
      await Bun.write(path.join(tmp.path, "htmly-1.7.0.vsix"), "vsix")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "which vsix was packaged?" }],
                tools: {},
              })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { output?: string; error?: string; tool_call_ids: string[] }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions[0]?.error).toBeUndefined()
              expect(protocol?.runs?.[0]?.actions[0]?.output).toContain("htmly-1.7.0.vsix")
              expect(protocol?.runs?.[0]?.actions[0]?.tool_call_ids.length).toBe(1)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner recovers minimax AgentProtocolOutput xml", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "我需要检查 PropertyPanel.tsx。",
                '{"<tool_call>',
                ']<]minimax[>[<invoke name="AgentProtocolOutput">',
                "]<]minimax[>[<kind>act</kind>",
                "]<]minimax[>[<message>检查组件文件</message>",
                "]<]minimax[>[<calls>",
                "]<]minimax[>[<item>",
                "]<]minimax[>[<id>find_tsx</id>",
                "]<]minimax[>[<type>tool</type>",
                "]<]minimax[>[<name>glob</name>",
                "]<]minimax[>[<args><pattern>**/*.tsx</pattern></args>",
                "]<]minimax[>[<result>summary</result>",
                "]<]minimax[>[</item>",
                "]<]minimax[>[</calls>",
                "]<]minimax[>[</invoke>}",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      if (calls === 3) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify({
                  type: "agent.protocol.output",
                  version: "1",
                  intent: "respond",
                  title: "Answer",
                  payload: { type: "message" },
                  response_ref: "md:response",
                }),
                "```",
                "",
                "## response",
                "Recovered AgentProtocolOutput XML.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: "I need to inspect a component. minimax:tool_call" }
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
      await Bun.write(path.join(tmp.path, "PropertyPanel.tsx"), "export const PropertyPanel = () => null")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "inspect PropertyPanel.tsx" }],
                tools: {},
              })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { operation: string; executor: { target: string }; output?: string; error?: string }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions[0]?.operation).toBe("glob")
              expect(protocol?.runs?.[0]?.actions[0]?.executor.target).toBe("glob")
              expect(protocol?.runs?.[0]?.actions[0]?.error).toBeUndefined()
              expect(protocol?.runs?.[0]?.actions[0]?.output).toContain("PropertyPanel.tsx")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner recovers minimax bare tool call xml", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "修复上轮空参数错误：重发查询请求。",
                '{"type":"tool-call",',
                "]<]minimax[>[<id>find_tsx]<]minimax[>[</id>",
                "]<]minimax[>[<type>tool]<]minimax[>[</type>",
                "]<]minimax[>[<name>glob]<]minimax[>[</name>",
                "]<]minimax[>[<args>]<]minimax[>[<pattern>**/*.tsx]<]minimax[>[</pattern>]<]minimax[>[</args>}",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      if (calls === 3) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify({
                  type: "agent.protocol.output",
                  version: "1",
                  intent: "respond",
                  title: "Answer",
                  payload: { type: "message" },
                  response_ref: "md:response",
                }),
                "```",
                "",
                "## response",
                "Recovered bare MiniMax call.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: "I need to inspect a component. minimax:tool_call" }
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
      await Bun.write(path.join(tmp.path, "PropertyPanel.tsx"), "export const PropertyPanel = () => null")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "which tsx exists?" }],
                tools: {},
              })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { output?: string; error?: string; tool_call_ids: string[] }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions[0]?.error).toBeUndefined()
              expect(protocol?.runs?.[0]?.actions[0]?.output).toContain("PropertyPanel.tsx")
              expect(protocol?.runs?.[0]?.actions[0]?.tool_call_ids.length).toBe(1)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner retries noisy multi-block output before execution", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      type: "agent.protocol",
      version: "1",
      intent: "execute",
      title: "Inspect json files",
      execution: { strategy: "sequential" },
      payload: {
        type: "action_graph",
        actions: [
          {
            type: "action",
            id: "find",
            title: "Find json files",
            operation: "inspect",
            executor: { type: "tool", target: "glob", capabilities: ["repo"] },
            input: { pattern: "*.json" },
            prompt_ref: "md:find",
            result_policy: "summary",
          },
        ],
      },
    }
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 3) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify({
                  type: "agent.protocol.output",
                  version: "1",
                  intent: "respond",
                  title: "Answer",
                  payload: { type: "message" },
                  response_ref: "md:response",
                }),
                "```",
                "",
                "## response",
                "Found package metadata.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: [
                "```json agent-protocol",
                JSON.stringify(data),
                "```",
                "",
                "## find",
                "Find package metadata.",
              ].join("\n"),
            }
            yield { type: "text-end" }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
            yield { type: "finish" }
          })(),
        } as never
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "reasoning-start" }
          yield { type: "reasoning-delta", text: "Need files." }
          yield { type: "reasoning-end" }
          yield { type: "text-start" }
          yield {
            type: "text-delta",
            text: [
              "我来检查项目结构。",
              "```json agent-protocol",
              JSON.stringify(data),
              "```",
              "",
              "## find",
              "Find package metadata.",
              "",
              "<protocol-result>{\"status\":\"completed\"}</protocol-result>",
              "",
              "```json agent-protocol",
              JSON.stringify({ ...data, title: "Second fake run" }),
              "```",
            ].join("\n"),
          }
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
      await Bun.write(path.join(tmp.path, "package.json"), "{}")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
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
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "inspect package files" }],
                tools: {},
              })
              const parts = await MessageV2.parts(assistant.id)
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { output?: string; tool_call_ids: string[] }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(parts.some((part) => part.type === "reasoning" && part.text.includes("Need files."))).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored)).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.text.includes("agent-protocol") && !part.ignored)).toBe(false)
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions[0]?.output).toContain("package.json")
              expect(protocol?.runs?.[0]?.actions[0]?.tool_call_ids.length).toBe(1)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })
})
