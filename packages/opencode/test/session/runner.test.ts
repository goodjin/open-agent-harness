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
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
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
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol" && part.ignored)).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.text.includes("agent-protocol") && !part.ignored)).toBe(false)
              expect(parts.some((part) => part.type === "tool" && part.metadata?.protocol === true)).toBe(true)
              expect(finalParts.some((part) => part.type === "text" && part.text.includes("Final answer"))).toBe(true)
              expect(calls).toBe(2)
              expect(inputs[1]?.messages).toHaveLength(4)
              expect(JSON.stringify(inputs[1]?.messages)).toContain("[TOOL_CALL]")
              expect(JSON.stringify(inputs[1]?.messages)).toContain("old turn")
              expect(JSON.stringify(inputs[1]?.messages)).toContain("inspect")
              expect(JSON.stringify(inputs[1]?.messages)).toContain("<agent-protocol-observation>")
              expect(JSON.stringify(inputs[1]?.messages)).toContain("执行状态")
              expect(JSON.stringify(inputs[1]?.messages)).toContain("protocol target")
              expect(protocol?.runs?.[0]?.total).toBe(3)
              expect(protocol?.runs?.[0]?.actions.find((item) => item.id === "delegate")?.output).toContain("agent:default")
              expect(protocol?.runs?.[0]?.actions.find((item) => item.id === "read")?.output).toContain("protocol target")
            },
          }),
      })
    } finally {
      hook.mockRestore()
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
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      title: "Read package",
      message: "Protocol violation recovered: direct read was converted.",
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
    const reply = {
      type: "agent.protocol.output",
      version: "1",
      intent: "respond",
      title: "Answer",
      message: "Read package successfully.",
      actions: [],
    }
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      const input = calls === 1 ? data : reply
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
              expect(JSON.stringify(inputs[2]?.messages)).toContain("执行状态")
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
