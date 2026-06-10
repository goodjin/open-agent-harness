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
import { Question } from "../../src/question"
import { Provider } from "../../src/provider/provider"
import { SessionStatus } from "../../src/session/status"
import { SessionDelegation } from "../../src/session/delegation"
import { WorkflowState } from "../../src/workflow/state"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { tmpdir } from "../fixture/fixture"
import { AgentDelegation } from "../../src/agent/delegation"
import { Agent } from "../../src/agent/agent"
import { AgentProtocol } from "../../src/protocol/schema"

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

    expect(result).toBe("stop")
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

    expect(result).toBe("stop")
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

  test("protocol completion result satisfies default metadata evidence", async () => {
    const done = AgentDelegation.complete({
      agent: "default",
      meta: {
        completion: {
          criteria: [],
          required_artifacts: [],
          required_evidence: ["protocol_run_state_or_direct_answer"],
          gates: [],
          allow_partial: true,
        },
      },
      result: await SessionRunner.proof({
        type: "agent.protocol.result",
        version: "1",
        run_id: "apr_done",
        status: "completed",
        title: "backend",
        actions: [],
        summary: "backend completed",
        time: {
          started: Date.now(),
          completed: Date.now(),
        },
        metrics: {
          actions: 0,
          internal_tool_calls: 0,
          direct_model_tool_calls: 0,
          model_visible_bytes: 0,
          raw_output_bytes: 0,
          duration_ms: 0,
        },
      }),
      status: "completed",
    })

    expect(done.status).toBe("completed")
    expect(done.completion.missing_evidence).toEqual([])
  })

  test("protocol proof caches large action output to disk", async () => {
    const text = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n")
    const result = await SessionRunner.proof({
      type: "agent.protocol.result",
      version: "1",
      run_id: "apr_large",
      status: "completed",
      title: "large output",
      actions: [
        {
          id: "a1",
          title: "large command",
          operation: "bash",
          status: "completed",
          executor: { type: "tool", target: "bash", capabilities: ["repo"] },
          input: {},
          depends_on: [],
          summary: "large command completed",
          output: text,
          tool_call_ids: [],
          duration_ms: 0,
          time: {
            started: Date.now(),
            completed: Date.now(),
          },
        },
      ],
      summary: "large output completed",
      time: {
        started: Date.now(),
        completed: Date.now(),
      },
      metrics: {
        actions: 1,
        internal_tool_calls: 1,
        direct_model_tool_calls: 0,
        model_visible_bytes: 0,
        raw_output_bytes: text.length,
        duration_ms: 0,
      },
    })

    expect(result.content).toContain("Full output saved to:")
    expect(result.content).not.toContain("[Output truncated:")
    const match = result.content.match(/Full output saved to: (.+)/)
    if (!match?.[1]) throw new Error("expected output path")
    expect(await fs.readFile(match[1], "utf8")).toBe(text)
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
            operation: "general_research",
            executor: { type: "agent", target: "auto", capabilities: ["general_research"] },
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
    let prompts = 0
    let done = 0
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
      prompts++
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
        text: "agent:general child summary",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      done++
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
                  entry: {
                    primary: true,
                    delegable: false,
                    mentionable: true,
                    default: false,
                    hidden: false,
                  },
                  capability: {
                    purpose: "protocol_orchestration",
                    tags: [],
                    cost: "low",
                    writes: false,
                  },
                  permission: [{ permission: "*", pattern: "*", action: "allow" }],
                  inheritPermissions: false,
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
              for (let i = 0; i < 20 && done < 2; i++) await Bun.sleep(10)
              expect(prompts).toBeGreaterThanOrEqual(2)
              expect(done).toBeGreaterThanOrEqual(2)
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
      version: "2",
      items: [
        {
          id: "read_package",
          kind: "tool",
          target: "read",
          args: { filePath: "package.json" },
          result: "summary",
        },
      ],
    }
    const reply = {
      version: "2",
      items: [
        {
          id: "reply",
          kind: "answer",
          message: "Read package successfully.",
        },
      ],
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
                runtimeTools: {
                  catalog: [
                    {
                      id: "read",
                      description: "Read file",
                      schema: {
                        type: "object",
                        properties: {
                          filePath: { type: "string" },
                        },
                        required: ["filePath"],
                      },
                    },
                  ],
                  prompt: "# Available Protocol Tools\n\n## read",
                  execute: async () => ({
                    title: "package.json",
                    output: JSON.stringify({ name: "native-protocol" }),
                    metadata: {},
                  }),
                } as never,
              })
              const messages = await Session.messages({ sessionID: session.id })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { output?: string; summary?: string; tool_call_ids: string[] }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions[0]?.summary ?? protocol?.runs?.[0]?.actions[0]?.output).toContain("native-protocol")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Read package successfully.")))).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("recovers unfinished native protocol output and restores pending confirm", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const hook = spyOn(Provider, "getModel").mockImplementation(async () => model)

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
                finish: "tool-calls",
                time: { created: Date.now(), completed: Date.now() },
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: assistant.id,
                type: "tool",
                callID: "call_protocol_resume",
                tool: LLM.PROTOCOL_OUTPUT_TOOL,
                state: {
                  status: "completed",
                  input: {
                    version: "2",
                    items: [
                      {
                        id: "confirm_plan",
                        kind: "confirm",
                        title: "Confirm plan",
                        prompt: "Confirm this plan before execution.",
                        plan: "1. Inspect alignment guides.\n2. Patch snapping behavior.",
                      },
                    ],
                  },
                  title: "Agent Protocol Output",
                  output: "Agent Protocol package received.",
                  metadata: { protocol: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } satisfies MessageV2.ToolPart)

              expect(await SessionRunner.recover({ sessionID: session.id })).toBe(true)
              for (let i = 0; i < 20 && (await Question.list()).length === 0; i++) await Bun.sleep(10)
              const questions = await Question.list()
              const logs = await SessionLog.list({ sessionID: session.id })

              expect(questions).toHaveLength(1)
              expect(questions[0]?.questions[0]?.header).toBe("Confirm plan")
              expect(questions[0]?.questions[0]?.question).toContain("Inspect alignment guides")
              expect(logs.some((item) => item.type === "protocol.recovery.started")).toBe(true)
              await Question.reject(questions[0]!.id)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("does not replay interrupted non-idempotent tool protocol output", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const hook = spyOn(Provider, "getModel").mockImplementation(async () => model)

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
                finish: "tool-calls",
                time: { created: Date.now(), completed: Date.now() },
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: assistant.id,
                type: "tool",
                callID: "call_protocol_tool_resume",
                tool: LLM.PROTOCOL_OUTPUT_TOOL,
                state: {
                  status: "completed",
                  input: {
                    version: "2",
                    items: [{ id: "read_package", kind: "tool", target: "read", args: { filePath: "package.json" } }],
                  },
                  title: "Agent Protocol Output",
                  output: "Agent Protocol package received.",
                  metadata: { protocol: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } satisfies MessageV2.ToolPart)

              expect(await SessionRunner.recover({ sessionID: session.id })).toBe(true)
              for (let i = 0; i < 20 && SessionStatus.get(session.id).type !== "blocked"; i++) await Bun.sleep(10)
              const parts = await MessageV2.parts(assistant.id)

              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_recovery_hint")).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_context")).toBe(false)
              expect(SessionStatus.get(session.id).type).toBe("blocked")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("recovers agent protocol output without duplicating an existing active child", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const hook = spyOn(Provider, "getModel").mockImplementation(async () => model)

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
                finish: "tool-calls",
                time: { created: Date.now(), completed: Date.now() },
              })) as MessageV2.Assistant
              const body = {
                version: "2",
                items: [{ id: "plan_snap", kind: "agent", target: "feature-planner", prompt: "Plan snap guides." }],
              }
              await Session.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: assistant.id,
                type: "tool",
                callID: "call_protocol_agent_resume",
                tool: LLM.PROTOCOL_OUTPUT_TOOL,
                state: {
                  status: "completed",
                  input: body,
                  title: "Agent Protocol Output",
                  output: "Agent Protocol package received.",
                  metadata: { protocol: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } satisfies MessageV2.ToolPart)
              const declaration = AgentProtocol.parse(body)
              if (declaration.payload.type !== "action_graph") throw new Error("expected action graph")
              const child = await Session.create({ parentID: session.id, title: "Protocol: plan_snap (@feature-planner)" })
              SessionStatus.set(child.id, { type: "running" })
              await SessionDelegation.assign({
                action: declaration.payload.actions[0]!,
                agent: "feature-planner",
                childID: child.id,
                messageID: assistant.id,
                parentAgent: "protocol-runner",
                runID: "apr_existing_child",
                sessionID: session.id,
              })

              expect(await SessionRunner.recover({ sessionID: session.id })).toBe(true)
              for (let i = 0; i < 20; i++) {
                const parts = await MessageV2.parts(assistant.id)
                if (parts.some((part) => part.type === "text" && part.text.includes("no duplicate child"))) break
                await Bun.sleep(10)
              }
              const children = await Session.children(session.id)
              const parts = await MessageV2.parts(assistant.id)

              expect(children).toHaveLength(1)
              expect(parts.some((part) => part.type === "text" && part.text.includes("no duplicate child"))).toBe(true)
              expect(SessionStatus.get(child.id).type).toBe("running")
              SessionStatus.set(child.id, { type: "idle" })
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner retries malformed native AgentProtocolOutput after plain progress text", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const inputs: LLM.StreamInput[] = []
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "tool-input-start", id: "call_protocol_retry", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
            yield {
              type: "tool-call",
              toolCallId: "call_protocol_retry",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input: {
                kind: "answer",
                message: "Retried with valid protocol output.",
              },
            }
            yield {
              type: "tool-result",
              toolCallId: "call_protocol_retry",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input: {
                kind: "answer",
                message: "Retried with valid protocol output.",
              },
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
      }
      return {
        fullStream: (async function* () {
          const err = "Invalid input for tool AgentProtocolOutput: JSON parsing failed: Text: {\"kind\":\"act\",\"calls\": . Error message: JSON Parse error: Unexpected EOF"
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: "Batch 1 completed. Dispatching batch 2." }
          yield { type: "text-end" }
          yield { type: "tool-input-start", id: "call_invalid_protocol", toolName: "invalid" }
          yield {
            type: "tool-call",
            toolCallId: "call_invalid_protocol",
            toolName: "invalid",
            input: {
              tool: LLM.PROTOCOL_OUTPUT_TOOL,
              error: err,
            },
          }
          yield {
            type: "tool-result",
            toolCallId: "call_invalid_protocol",
            toolName: "invalid",
            input: {
              tool: LLM.PROTOCOL_OUTPUT_TOOL,
              error: err,
            },
            output: {
              title: "Invalid Protocol Tool Call",
              output: `Protocol violation: attempted to call native tool '${LLM.PROTOCOL_OUTPUT_TOOL}'. ${err}`,
              metadata: {
                protocol: true,
                violation: "direct_tool_call",
                tool: LLM.PROTOCOL_OUTPUT_TOOL,
              },
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
                messages: [{ role: "user", content: "continue batch 2" }],
                tools: {},
              })
              const parts = await MessageV2.parts(assistant.id)
              const logs = await SessionLog.list({ sessionID: session.id })
              const messages = await Session.messages({ sessionID: session.id })

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored)).toBe(true)
              expect(logs.some((item) => item.type === "protocol.retry" && item.data.reason === "invalid_protocol_tool_call")).toBe(true)
              expect(JSON.stringify(inputs[1]?.system)).toContain("tool call was malformed")
              expect(JSON.stringify(inputs[1]?.system)).toContain("model did not strictly follow")
              expect(JSON.stringify(inputs[1]?.system)).toContain("JSON Parse error")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Retried with valid protocol output.")))).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner reports invalid native AgentProtocolOutput schema instead of missing tool", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const inputs: LLM.StreamInput[] = []
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      const body = calls === 1
        ? {
            version: "2",
            items: [{ id: "bad_tool", kind: "tool" }],
          }
        : {
            version: "2",
            items: [{ id: "answer", kind: "answer", message: "Recovered." }],
          }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: body,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: body,
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
                messages: [{ role: "user", content: "answer with protocol" }],
                tools: {},
              })
              const logs = await SessionLog.list({ sessionID: session.id })
              const messages = await Session.messages({ sessionID: session.id })
              const retry = logs.find((item) => item.type === "protocol.retry")
              const err = retry?.data.error as { message?: string } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(retry?.data.reason).toBe("invalid_protocol_tool_call")
              expect(err?.message).toContain("target")
              expect(err?.message).not.toContain("No native AgentProtocolOutput tool call found")
              expect(JSON.stringify(inputs[1]?.system)).toContain("tool call was malformed")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Recovered.")))).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner retries verifier packages that do not depend on workers", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const inputs: LLM.StreamInput[] = []
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      const body = calls === 1
        ? {
            version: "2",
            items: [
              { id: "impl", kind: "agent", target: "backend", prompt: "Implement backend change." },
              { id: "verify", kind: "agent", target: "backend-verifier", prompt: "Verify backend change." },
            ],
          }
        : {
            version: "2",
            items: [{ id: "answer", kind: "answer", message: "Regenerated without executing the bad package." }],
          }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: body,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: body,
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
                messages: [{ role: "user", content: "implement and verify backend" }],
                tools: {},
              })
              const logs = await SessionLog.list({ sessionID: session.id })
              const children = await Session.children(session.id)
              const messages = await Session.messages({ sessionID: session.id })
              const retry = logs.find((item) => item.type === "protocol.retry")

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(children).toHaveLength(0)
              expect(retry?.data.reason).toBe("invalid_verifier_dependency")
              expect(JSON.stringify(inputs[1]?.system)).toContain("invalid verifier dependencies")
              expect(JSON.stringify(inputs[1]?.system)).toContain("backend-verifier")
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Regenerated without executing")))).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner preserves confirmation gate before verifier dependency validation", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const body = {
      version: "2",
      items: [
        { id: "confirm_plan", kind: "confirm", prompt: "Approve?", plan: "Run backend work." },
        { id: "impl", kind: "agent", target: "backend", prompt: "Implement backend change.", depends: ["confirm_plan"] },
        {
          id: "verify",
          kind: "agent",
          target: "backend-verifier",
          prompt: "Verify backend change.",
          depends: ["confirm_plan"],
        },
      ],
    }
    const stream = spyOn(LLM, "stream").mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: "start" }
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: "call_1", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
        yield {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: LLM.PROTOCOL_OUTPUT_TOOL,
          input: body,
        }
        yield {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: LLM.PROTOCOL_OUTPUT_TOOL,
          input: body,
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
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => {
      if (name === "backend") return { name, kind: "worker" } as never
      if (name === "backend-verifier") return { name, kind: "verifier" } as never
      return undefined
    })
    const provider = spyOn(Provider, "getModel").mockImplementation(async () => model)

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
              const run = runner.process({
                user,
                sessionID: session.id,
                model,
                agent: {
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "implement and verify backend" }],
                tools: {},
              })

              let questions = await Question.list()
              for (let i = 0; i < 20 && questions.length === 0; i++) {
                await Bun.sleep(10)
                questions = await Question.list()
              }

              const children = await Session.children(session.id)
              const after = await Session.get(session.id)
              const protocol = after.dsl_context?.protocol as { confirmations?: { status: string }[] } | undefined

              expect(children).toHaveLength(0)
              expect(questions).toHaveLength(1)
              expect(questions[0]?.tool?.callID).toBe("call_confirm_plan")
              expect(protocol?.confirmations?.[0]?.status).toBe("pending")

              await Question.reject(questions[0]!.id).catch(() => {})
              await run.catch(() => undefined)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      agent.mockRestore()
      provider.mockRestore()
    }
  })

  test("protocol runner defers verifier until worker delegation completes", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const body = {
      version: "2",
      items: [
        { id: "impl", kind: "agent", target: "backend", prompt: "Implement backend change." },
        { id: "verify", kind: "agent", target: "backend-verifier", prompt: "Verify backend change.", depends: ["impl"] },
      ],
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
          input: body,
        }
        yield {
          type: "tool-result",
          toolCallId: "call_protocol",
          toolName: LLM.PROTOCOL_OUTPUT_TOOL,
          input: body,
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
        text: [
          "kind: success",
          "task_background: assigned by protocol test",
          "task_content: implement backend change",
          "completion_summary: done",
          "changed_files: none",
          "verification: not run",
          "blockers: none",
        ].join("\n"),
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
                messages: [{ role: "user", content: "implement and verify backend" }],
                tools: {},
              })
              const children = await Session.children(session.id)
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { status: string; actions: { id: string; status: string; error?: string; output?: string }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(children).toHaveLength(1)
              expect(children[0]?.title).toContain("@backend")
              expect(inputs[0]?.agent).toBe("backend")
              expect(inputs.some((item) => item.agent === "backend-verifier")).toBe(false)
              expect(protocol?.runs?.[0]?.status).toBe("blocked")
              expect(protocol?.runs?.[0]?.actions.find((item) => item.id === "verify")?.error).toContain("waiting for completed worker summaries")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
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
      message: "Delegate backend work.",
      calls: [
        {
          id: "update_toolbar_backend",
          type: "agent",
          name: "backend",
          args: { prompt: "Update toolbar button handlers" },
          result: "summary",
        },
      ],
    }
    let calls = 0
    let done = 0
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
      done++
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
              expect(children[0]?.title).toContain("Protocol: update_toolbar_backend")
              const child = await Session.get(children[0]!.id)
              expect(JSON.stringify(child.dsl_context)).toContain("agent.delegation.assignment")
              expect(child.agent).toBe("backend")
              expect(child.dsl_context).not.toHaveProperty("session_tree")
              expect(JSON.stringify(child.dsl_context)).toContain('"parent_session_id"')
              expect(JSON.stringify(protocol?.runs?.[0]?.actions[0])).toContain("The parent session will resume automatically")
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_summary" && part.text.includes("The parent session will resume automatically"))).toBe(true)
              for (let i = 0; i < 20 && done < 2; i++) await Bun.sleep(10)
              expect(done).toBeGreaterThanOrEqual(2)
              expect(inputs[0]?.agent).toBe("backend")
              expect(inputs[0]?.model).toEqual({
                providerID: ProviderID.make("openai"),
                modelID: ModelID.make("gpt-5.2"),
              })
              expect(inputs[1]?.agent).toBe("protocol-runner")
              expect(inputs[1]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(true)
              expect(inputs[1]?.parts?.some((part) => part.type === "text" && part.text.includes('"action_id": "update_toolbar_backend"'))).toBe(true)
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

  test("protocol final agent call uses target agent permissions by default", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = [
      {
        kind: "act",
        message: "Inspect package metadata.",
        calls: [
          {
            id: "inspect_package",
            type: "tool",
            name: "read",
            args: { filePath: "package.json" },
            result: "summary",
          },
        ],
      },
      {
        kind: "act",
        message: "Delegate planning follow-up.",
        calls: [
          {
            id: "feat_dirty_tracking",
            type: "agent",
            name: "backend",
            args: { prompt: "Implement dirty tracking backend state." },
            result: "structured",
          },
        ],
      },
    ]
    let calls = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      const input = data[calls++] ?? data.at(-1)!
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
        text: [
          "Delegated to backend.",
          "Child session: test",
          "The parent session will resume automatically when the child result is available.",
        ].join("\n"),
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
              await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
              const session = await Session.create({})
              await Session.setPermission({
                sessionID: session.id,
                permission: [
                  { permission: "read", pattern: "*", action: "allow" },
                  { permission: "task", pattern: "*", action: "deny" },
                ],
              })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "feature-planner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "feature-planner",
                agent: "feature-planner",
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
              const agent = await Agent.get("feature-planner")
              if (!agent) throw new Error("missing feature-planner agent")
              const result = await runner.process({
                user,
                sessionID: session.id,
                model,
                agent,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "inspect then decide next work" }],
                tools: {},
              })
              for (let i = 0; i < 20; i++) {
                if ((await Session.children(session.id)).length > 0) break
                await Bun.sleep(10)
              }
              const children = await Session.children(session.id)
              const messages = await Session.messages({ sessionID: session.id, limit: 10 })
              const final = messages.findLast((item) =>
                item.info.role === "assistant" &&
                item.parts.some((part) => part.type === "text" && part.text.includes("Protocol blocked")),
              )
              const text = messages.flatMap((item) =>
                item.parts.flatMap((part) => part.type === "text" ? [part.text] : []),
              ).join("\n")

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(children).toHaveLength(1)
              expect(children[0]?.title).toContain("Protocol: feat_dirty_tracking (@backend)")
              expect(text).toContain("The parent session will resume automatically")
              expect(text).not.toContain("Protocol blocked")
              expect(text).not.toContain("Protocol agent denied: backend")
              expect(text).not.toContain("Protocol final response was empty or malformed.")
              expect(final).toBeUndefined()
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
    }
  })

  test("default protocol runner falls back when model self-delegates to default", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      kind: "act",
      message: "Delegate planning.",
      calls: [
        {
          id: "plan_protocol_tasks",
          type: "agent",
          name: "default",
          args: { prompt: "Plan protocol parser tasks without editing files." },
          result: "structured",
        },
      ],
    }
    let done = 0
    const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
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
        text: `agent:${input.agent} completed`,
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      done++
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
                agent: "default",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                mode: "default",
                agent: "default",
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
                  name: "default",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "plan protocol parser tasks" }],
                tools: {},
              })
              const children = await Session.children(session.id)
              const after = await Session.get(session.id)
              const protocol = after.dsl_context?.protocol as {
                runs?: { actions: { output?: string }[] }[]
              } | undefined

              expect(result).toBe("stop")
              expect(children).toHaveLength(1)
              expect(children[0]?.title).toContain("@general")
              expect(protocol?.runs?.[0]?.actions[0]?.output).toContain("Delegated to general.")
              for (let i = 0; i < 20 && done < 2; i++) await Bun.sleep(10)
              expect(done).toBeGreaterThanOrEqual(2)
              expect(inputs[0]?.agent).toBe("general")
              expect(inputs[1]?.agent).toBe("default")
              const text = inputs[0]?.parts?.map((part) => part.type === "text" ? part.text : "").join("\n")
              expect(text).not.toContain("@default")
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
      text: Promise.resolve("Child metadata follow-up"),
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

  test("protocol runner stores metadata follow-up plans from child completion", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      kind: "answer",
      message: "Child final answer without required artifacts.",
    }
    const stream = spyOn(LLM, "stream").mockImplementation(async () => ({
      text: Promise.resolve("Child metadata follow-up"),
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
    const meta = spyOn(AgentDelegation, "meta").mockImplementation(async () => ({
      contracts: {
        input: [],
        output: [
          {
            name: "report",
            required: true,
            artifact_type: "verification_report",
          },
          {
            name: "log",
            required: true,
            artifact_type: "execution_log",
          },
        ],
      },
      collaboration: {
        edges: [
          {
            kind: "recovery",
            trigger: "output_validation_failed",
            target: "fixer",
            input: { prompt: "Produce missing artifacts" },
            depends: ["child_task"],
          },
        ],
      },
    }))

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
                messages: [{ role: "user", content: "finish child" }],
                tools: {},
              })
              const ctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: {
                  metadata?: {
                    followup?: {
                      items?: Record<string, unknown>[]
                    }
                  }
                }[]
              }

              expect(result).toBe("stop")
              expect(ctx.completed_delegations?.[0]?.metadata?.followup?.items?.[0]).toEqual({
                kind: "action",
                id: "protocol-runner-recovery-fixer",
                edge_kind: "recovery",
                target: "fixer",
                required: false,
                failure_policy: "retry",
                dedupe_key: "protocol-runner:recovery:fixer",
                depends: ["child_task"],
                trigger: "output_validation_failed",
                input: { prompt: "Produce missing artifacts" },
                source: {
                  agent: "protocol-runner",
                  depth: 1,
                },
              })
            },
          }),
      })
    } finally {
      stream.mockRestore()
      meta.mockRestore()
    }
  })

  test("protocol runner falls back to plain markdown final responses after retry", async () => {
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
      if (calls === 2 || calls === 3) {
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
              console.log("DEBUG before process")
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

              expect(calls).toBe(3)
              expect(inputs[1]?.toolChoice).toBeUndefined()
              expect(inputs[2]?.system.join("\n")).toContain("Protocol retry warning")
              expect(inputs[2]?.system.join("\n")).toContain('kind: "done"')
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Plain final answer.") && !part.ignored))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.retry")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.plain" && item.data.fallback === true)).toBe(true)
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(false)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner falls back to plain markdown follow-up answers after retry", async () => {
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
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Phase 1-4") && !part.ignored))).toBe(true)
              expect(messages.every((item) => item.parts.every((part) => part.type !== "text" || part.metadata?.kind !== "protocol_malformed" || part.ignored))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.plain")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner accepts plain JSON answer in final text output", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const data = {
      version: "2",
      title: "Read package",
      items: [
        {
          id: "read_package",
          kind: "tool",
          target: "read",
          args: { filePath: "package.json" },
          depends: [],
          result: "summary",
        },
      ],
    }
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 1) {
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
                output: "Agent Protocol output received.",
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
      }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield { type: "text-delta", text: '{"kind":"answer","answer":"Recovered from plain JSON answer."}' }
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
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ name: "plain-final-json" }))
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
                runtimeTools: {
                  catalog: [
                    {
                      id: "read",
                      description: "Read package",
                      schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
                    },
                  ],
                  prompt: "# Available Protocol Tools",
                  execute: async () => ({
                    title: "package.json",
                    output: JSON.stringify({ name: "plain-final-json" }),
                    metadata: {},
                  }),
                } as never,
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("Recovered from plain JSON answer.")))).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.malformed")).toBe(false)
              expect(logs.some((item) => item.type === "protocol.final.retry")).toBe(false)
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

  test("protocol runner rejects textual tool-call output instead of recovering it", async () => {
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

              expect(result).toBe("continue")
              expect(calls).toBe(2)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored)).toBe(true)
              expect(protocol?.runs).toBeUndefined()
              expect(JSON.stringify(inputs[1]?.system)).toContain("previous response violated")
              expect(JSON.stringify(inputs[1]?.system)).toContain("provider-specific textual tool call")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner does not recover textual AgentProtocolOutput json", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let done = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          yield {
            type: "text-delta",
            text: [
              "T-CMD-001 completed. Dispatch the next task.",
              JSON.stringify({
                name: "AgentProtocolOutput",
                input: {
                  kind: "act",
                  message: "Dispatch database work.",
                  calls: [
                    {
                      id: "exec_t_cmd_002",
                      type: "agent",
                      name: "database-agent",
                      args: {
                        prompt: "Implement src/db/schema/commands.ts after reviewing src/command/schema.ts.",
                      },
                      result: "summary",
                    },
                  ],
                },
              }),
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
        text: "Database agent completed.",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      done++
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
                permission: [{ permission: "task", pattern: "*", action: "allow" }],
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
                messages: [{ role: "user", content: "continue after T-CMD-001" }],
                tools: {},
                runtimeTools: {
                  tools: {},
                  catalog: [],
                  prompt: "",
                  execute: async () => {
                    throw new Error("No direct tools should run")
                  },
                },
              })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as {
                runs?: { title?: string; status: string; actions: { operation: string; executor: { target: string } }[] }[]
              } | undefined

              expect(result).toBe("continue")
              expect(protocol?.runs).toBeUndefined()
              for (let i = 0; i < 20 && done > 0; i++) await Bun.sleep(10)
              expect(done).toBe(0)
            },
          }),
      })
    } finally {
      hook.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner does not recover xml glob tool calls", async () => {
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

              expect(result).toBe("continue")
              expect(calls).toBe(2)
              expect(protocol?.runs).toBeUndefined()
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

  test("verifier dependency validation: schema leaves empty depends_on for runtime rejection", () => {
    // A V2 protocol with no depends reaches the runtime untouched so the
    // runtime can reject the package before execution and ask the model to regenerate it.
    const decl = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "impl_1", kind: "agent", target: "backend", prompt: "do work", depends: [] },
        { id: "verify_1", kind: "agent", target: "backend-verifier", prompt: "verify", depends: [] },
      ],
    })
    if (decl.payload?.type !== "action_graph") throw new Error("not action_graph")
    const verify = decl.payload.actions.find((a) => a.id === "verify_1")
    expect(verify?.depends_on).toEqual([])
  })

  test("verifier dependency validation: 'none' sentinel is stripped before runtime rejection", () => {
    // The schema strips the legacy sentinel before validation. For verifier
    // items, the runtime now treats the resulting empty depends_on as invalid.
    const decl = AgentProtocol.parse({
      version: "2",
      items: [
        { id: "review", kind: "agent", target: "security-reviewer", prompt: "review", depends: ["none"] },
      ],
    })
    if (decl.payload?.type !== "action_graph") throw new Error("not action_graph")
    const review = decl.payload.actions.find((a) => a.id === "review")
    expect(review?.depends_on).toEqual([])
  })

})
