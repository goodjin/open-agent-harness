import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunner } from "../../src/session/runner"
import { SessionLog } from "../../src/session/log"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { Question } from "../../src/question"
import { Provider } from "../../src/provider/provider"
import { SessionStatus } from "../../src/session/status"
import { SessionDelegation } from "../../src/session/delegation"
import { SessionTurn } from "../../src/session/turn"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionResult } from "../../src/session/result"
import { WorkflowState } from "../../src/workflow/state"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { tmpdir } from "../fixture/fixture"
import { AgentDelegation } from "../../src/agent/delegation"
import { Agent } from "../../src/agent/agent"
import { AgentProtocol } from "../../src/protocol/schema"
import { Storage } from "../../src/storage/storage"
import { SessionRuns } from "../../src/session/runs"
import { SessionTask } from "../../src/session/task"

describe("SessionRunner", () => {
  const finalTools = {
    catalog: [
      {
        id: "read",
        description: "Read a file",
        schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      },
      {
        id: "glob",
        description: "Find files",
        schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      },
    ],
    prompt: "# Available Protocol Tools",
    execute: async (id: string, args: unknown) => ({
      title: id,
      output: JSON.stringify(args),
      metadata: {},
    }),
  } as never

  const packet = (input: unknown, id: string) => ({
    fullStream: (async function* () {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "tool-input-start", id, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
      yield { type: "tool-call", toolCallId: id, toolName: LLM.PROTOCOL_OUTPUT_TOOL, input }
      yield {
        type: "tool-result",
        toolCallId: id,
        toolName: LLM.PROTOCOL_OUTPUT_TOOL,
        input,
        output: { output: "Agent Protocol package received.", title: "Agent Protocol Output", metadata: {} },
      }
      yield {
        type: "finish-step",
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
      yield { type: "finish" }
    })(),
  }) as never

  const poll = async (fn: () => boolean | Promise<boolean>, timeout = 5_000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await fn()) return
      await Bun.sleep(10)
    }
    throw new Error("condition timeout")
  }

  const run = (id: string): AgentProtocol.Result => ({
    type: "agent.protocol.result",
    version: "1",
    run_id: id,
    status: "completed",
    actions: [],
    summary: "runtime action summary",
    time: { started: Date.now(), completed: Date.now() },
    metrics: {
      actions: 0,
      duration_ms: 1,
      internal_tool_calls: 0,
      direct_model_tool_calls: 0,
      model_visible_bytes: 0,
      raw_output_bytes: 0,
    },
  })

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
        steps: [
          { id: "first", outputs: { first: "$input" } },
          { id: "second", outputs: { second: "$first" } },
        ],
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
        steps: [
          { id: "first", outputs: { first: "done" } },
          { id: "second", outputs: { second: "$first" } },
        ],
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
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const hook = spyOn(WorkflowExecutor, "continueRun").mockImplementation(async () => {
      enter()
      return wait
    })

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
              const session = await Session.create({
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              })
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

              const completed = {
                ...state,
                status: "completed",
                completed: ["first", "second"],
                statuses: { first: "completed", second: "completed" },
                time: { ...state.time, completed: Date.now() },
              } as WorkflowState.Info

              try {
                await entered
                const before = await MessageV2.parts(assistant.id)
                expect(before).toHaveLength(1)
                expect(before[0]?.type).toBe("text")
                expect(before[0]?.type === "text" && before[0].text.includes("active")).toBe(true)
                expect((before[0] as MessageV2.TextPart).metadata?.kind).toBe("workflow")
                expect((before[0] as MessageV2.TextPart).metadata?.action).toBe("continued")

                done(completed)

                expect(await pending).toBe("stop")
                const after = await MessageV2.parts(assistant.id)
                expect(after).toHaveLength(1)
                expect(after[0]?.type === "text" && after[0].text.includes("completed")).toBe(true)
                expect((after[0] as MessageV2.TextPart).metadata?.kind).toBe("workflow")
                expect((after[0] as MessageV2.TextPart).metadata?.action).toBe("continued")
              } finally {
                done(completed)
                await pending
              }
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
              expect(await Bun.file(path.join(tmp.path, ".opencode", "workflows", "generated.json")).exists()).toBe(
                true,
              )
              expect(state?.workflowID).toBe("generated")
              expect(state?.variables.reviewed).toBe("review toolbar buttons")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner binds a legacy session task before executable actions", async () => {
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
            executor: { type: "agent", target: "general-investigator", capabilities: ["general_research"] },
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
        text: "agent:general-investigator child summary",
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
                  { role: "assistant", content: '[TOOL_CALL]\n{tool => "read"}\n[/TOOL_CALL]' },
                  { role: "user", content: "inspect" },
                ],
                tools: {},
              })
              const parts = await MessageV2.parts(assistant.id)
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: {
                      runID: string
                      total: number
                      actions: { id: string; status: string; output?: string }[]
                    }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(
                parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_context"),
              ).toBe(true)
              expect(
                parts.some((part) => part.type === "text" && part.text.includes("agent-protocol") && !part.ignored),
              ).toBe(false)
              expect(parts.some((part) => part.type === "tool" && part.metadata?.protocol === true)).toBe(true)
              expect(protocol?.runs?.[0]?.total).toBe(3)
              expect(await SessionTask.current(session.id)).toMatchObject({ title: "Inspect", version: 1 })
              const children = await Session.children(session.id)
              expect(children).toHaveLength(1)
              expect(await SessionTask.current(children[0]!.id)).toMatchObject({
                title: "Delegate summary",
                version: 1,
              })
            },
          }),
      })
    } finally {
      hook.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner rejects task conflict before confirm or executable callbacks", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const stream = spyOn(LLM, "stream").mockImplementation(async () =>
      packet(
        {
          version: "2",
          items: [
            {
              id: "confirm_conflict",
              kind: "confirm",
              title: "Conflicting task",
              prompt: "Confirm another task.",
              plan: "This plan must never be shown.",
              assignment: { op: "create", target: "self" },
            },
            { id: "execute_conflict", kind: "tool", target: "read", args: { filePath: "package.json" } },
          ],
        },
        "call_task_conflict",
      ),
    )
    let tools = 0
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await SessionTask.route({
                sessionID: session.id,
                runID: "run_existing_task",
                assignment: { op: "create", target: "self", title: "Existing task", body: "Existing plan" },
                actions: [{ id: "existing" }],
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
              await expect(
                runner.process({
                  user,
                  sessionID: session.id,
                  model,
                  agent: { name: "protocol-runner", runner: "protocol" } as never,
                  system: [],
                  abort: new AbortController().signal,
                  messages: [{ role: "user", content: "create conflicting task" }],
                  tools: {},
                  runtimeTools: {
                    catalog: [],
                    prompt: "",
                    execute: async () => {
                      tools++
                      return { title: "read", output: "unexpected", metadata: {} }
                    },
                  } as never,
                }),
              ).rejects.toThrow("session_task_conflict")
              expect(await Question.list()).toHaveLength(0)
              expect(tools).toBe(0)
              expect(await SessionAssignment.active(session.id)).toBeUndefined()
            },
          }),
      })
    } finally {
      stream.mockRestore()
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
        {
          id: "read_source",
          kind: "tool",
          target: "read",
          args: { filePath: "src/index.ts" },
          result: "summary",
        },
      ],
    }
    const reply = {
      version: "2",
      items: [
        {
          id: "reply",
          kind: "success",
          answer: "Read package successfully.",
          summary: "Both requested files were inspected.",
          changed_files: ["package.json"],
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: {
                      status: string
                      actions: { output?: string; summary?: string; tool_call_ids: string[] }[]
                    }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(1)
              const runs = await SessionRuns.list(session.id)
              expect(runs[0]?.summary).toBe(
                "Read package successfully.\n\nBoth requested files were inspected.\n\nChanged files: package.json",
              )
              expect(runs[0]?.summary_source).toBe("protocol")
              expect(protocol?.runs?.[0]?.status).toBe("completed")
              expect(protocol?.runs?.[0]?.actions).toHaveLength(2)
              expect(protocol?.runs?.[0]?.actions[0]?.summary ?? protocol?.runs?.[0]?.actions[0]?.output).toContain(
                "native-protocol",
              )
              expect(
                messages.some((item) =>
                  item.parts.some((part) => part.type === "text" && part.text.includes("Read package successfully.")),
                ),
              ).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner persists a failed run when verifier preparation throws after action start", async () => {
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
        {
          id: "verify_package",
          kind: "agent",
          target: "failing-verifier",
          prompt: "Verify package state.",
          result: "summary",
        },
      ],
    }
    let calls = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      const input =
        calls === 1
          ? body
          : {
              version: "2",
              items: [{ id: "answer", kind: "answer", message: "The tool failed." }],
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
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => {
      if (name === "failing-verifier") return { name, kind: "verifier" } as never
      return undefined
    })
    const query = spyOn(SessionDelegation, "query").mockImplementation(async () => {
      throw new Error("verifier preparation failed")
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
              const result = await runner
                .process({
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
                .catch((err) => err)
              const rows = await Storage.list(["session_protocol_run", session.id])
              const stored = rows[0] ? await Storage.read<AgentProtocol.Result>(rows[0]) : undefined
              const current = await Session.get(session.id)
              const protocol = current.dsl_context?.protocol as
                | { runs?: { status?: string; actions?: { status?: string; error?: string }[] }[] }
                | undefined

              expect(rows).toHaveLength(1)
              expect(result).toBe("stop")
              expect(stored?.status).toBe("failed")
              expect(stored?.actions[0]?.status).toBe("failed")
              expect(stored?.actions[0]?.error).toContain("verifier preparation failed")
              expect(protocol?.runs?.[0]?.status).toBe("failed")
              expect(protocol?.runs?.[0]?.actions?.[0]?.status).toBe("failed")
              expect(protocol?.runs?.[0]?.actions?.[0]?.error).toContain("verifier preparation failed")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      agent.mockRestore()
      query.mockRestore()
    }
  })

  test("protocol runner rethrows aborts after action start without running independent actions", async () => {
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
        {
          id: "confirm_tools",
          kind: "confirm",
          prompt: "Run tools?",
          plan: "Run the confirmed tools.",
        },
        {
          id: "read_failed",
          kind: "tool",
          target: "read",
          args: { filePath: "failed.json" },
        },
        {
          id: "read_abort",
          kind: "tool",
          target: "read",
          args: { filePath: "abort.json" },
        },
        {
          id: "read_after_abort",
          kind: "tool",
          target: "read",
          args: { filePath: "after.json" },
        },
      ],
    }
    const abort = new AbortController()
    let calls = 0
    let tools = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      const input =
        calls === 1
          ? body
          : {
              version: "2",
              items: [{ id: "answer", kind: "answer", message: "Unexpected final follow-up." }],
            }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_abort_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_abort_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_abort_${calls}`,
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
    const emit = SessionLog.emit
    const cleanup = spyOn(SessionLog, "emit").mockImplementation(async (input) => {
      if (input.type === "tool.error") throw new Error("simulated abort cleanup failure")
      return emit(input)
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
                abort: abort.signal,
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
                abort: abort.signal,
                messages: [{ role: "user", content: "verify then read" }],
                tools: {},
                runtimeTools: {
                  catalog: [
                    {
                      id: "read",
                      description: "Read file",
                      schema: {
                        type: "object",
                        properties: { filePath: { type: "string" } },
                        required: ["filePath"],
                      },
                    },
                  ],
                  prompt: "",
                  execute: async (_id: string, args: unknown) => {
                    const file = (args as { filePath?: string }).filePath
                    if (file === "failed.json") {
                      return {
                        title: "failed",
                        output: "unique failed output before abort",
                        metadata: { failed: true, toolCallIDs: ["inner_failed"] },
                      }
                    }
                    if (file === "abort.json") {
                      const err = new DOMException("Aborted", "AbortError")
                      abort.abort(err)
                      throw err
                    }
                    tools++
                    return { title: "read", output: "unexpected", metadata: {} }
                  },
                } as never,
              })
              await poll(async () => (await Question.list()).length > 0)
              const questions = await Question.list()
              expect(questions).toHaveLength(1)
              const released = Date.now()
              await Question.reply({
                requestID: questions[0]!.id,
                answers: [["Confirm"]],
                response: "confirm",
              })
              const result = await run.catch((err) => err)
              const messages = await Session.messages({ sessionID: session.id })
              const part = messages
                .flatMap((item) => item.parts)
                .find((item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === "call_read_abort")
              const current = await Session.get(session.id)
              const protocol = current.dsl_context?.protocol as { runs?: { status?: string }[] } | undefined
              const logs = await SessionLog.list({ sessionID: session.id })
              const rows = await Storage.list(["session_protocol_run", session.id])
              const stored = rows[0] ? await Storage.read<AgentProtocol.Result>(rows[0]) : undefined
              const trace = stored
                ? await SessionLog.protocolTrace({ sessionID: session.id, runID: stored.run_id })
                : undefined
              const events = logs
                .filter((item) => item.type === "protocol.action.tool_call" && item.data.runID === stored?.run_id)
                .map((item) => item.data.callID)
              const lifecycle = logs
                .filter((item) =>
                  [
                    "protocol.started",
                    "protocol.action.completed",
                    "protocol.action.failed",
                    "protocol.action.blocked",
                    "protocol.completed",
                    "protocol.failed",
                    "protocol.final.started",
                  ].includes(item.type),
                )
                .map((item) => item.type)

              expect(result).toBe(abort.signal.reason)
              expect(calls).toBe(1)
              expect(tools).toBe(0)
              expect(part?.state.status).toBe("error")
              expect(rows).toHaveLength(1)
              expect(stored?.status).toBe("failed")
              expect(stored?.actions[0]?.status).toBe("completed")
              expect(stored?.actions[1]?.status).toBe("failed")
              expect(stored?.actions[1]?.output).toBeUndefined()
              expect(stored?.actions[1]?.error).toBe("unique failed output before abort")
              expect(stored?.actions[1]?.summary).toBe("unique failed output before abort")
              expect(stored?.actions[1]?.tool_call_ids).toEqual(["call_read_failed", "inner_failed"])
              expect(stored?.actions[1]?.duration_ms).toBeGreaterThanOrEqual(0)
              expect(stored?.actions[2]?.status).toBe("failed")
              expect(stored?.actions[2]?.error).toContain("cancelled")
              expect(stored?.actions[3]?.status).toBe("blocked")
              expect(stored?.metrics.internal_tool_calls).toBe(2)
              expect(events).toEqual(["call_read_failed", "inner_failed"])
              expect(trace?.tool_calls.map((item) => item.call_id)).toEqual(events)
              expect(trace?.metrics.internal_tool_calls).toBe(stored?.metrics.internal_tool_calls)
              expect(stored?.time.started).toBeGreaterThanOrEqual(released)
              expect((stored?.time.started ?? released) - released).toBeLessThan(1000)
              expect(protocol?.runs?.[0]?.status).toBe("failed")
              expect(lifecycle).toEqual([
                "protocol.started",
                "protocol.action.completed",
                "protocol.action.failed",
                "protocol.action.failed",
                "protocol.action.blocked",
                "protocol.failed",
              ])
            },
          }),
      })
    } finally {
      stream.mockRestore()
      cleanup.mockRestore()
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
              await poll(async () => (await Question.list()).length > 0)
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
              await poll(() => SessionStatus.get(session.id).type === "blocked")
              const parts = await MessageV2.parts(assistant.id)

              expect(
                parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_recovery_hint"),
              ).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_dsl")).toBe(
                false,
              )
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
              const child = await Session.create({
                parentID: session.id,
                title: "Protocol: plan_snap (@feature-planner)",
              })
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
              await poll(async () =>
                (await MessageV2.parts(assistant.id)).some(
                  (part) => part.type === "text" && part.text.includes("no duplicate child"),
                ),
              )
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
          const err =
            'Invalid input for tool AgentProtocolOutput: JSON parsing failed: Text: {"kind":"act","calls": . Error message: JSON Parse error: Unexpected EOF'
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
              expect(
                parts.some(
                  (part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored,
                ),
              ).toBe(true)
              expect(
                logs.some(
                  (item) => item.type === "protocol.retry" && item.data.reason === "invalid_protocol_tool_call",
                ),
              ).toBe(true)
              expect(JSON.stringify(inputs[1]?.system)).toContain("tool call was malformed")
              expect(JSON.stringify(inputs[1]?.system)).toContain("model did not strictly follow")
              expect(JSON.stringify(inputs[1]?.system)).toContain("JSON Parse error")
              expect(
                messages.some((item) =>
                  item.parts.some(
                    (part) => part.type === "text" && part.text.includes("Retried with valid protocol output."),
                  ),
                ),
              ).toBe(true)
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
      const body = {
        version: "2",
        items: [{ id: "bad_tool", kind: "tool" }],
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
              const last = messages.findLast((item) => item.info.role === "assistant")
              const retry = logs.find((item) => item.type === "protocol.retry")
              const err = retry?.data.error as { message?: string } | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(retry?.data.reason).toBe("invalid_protocol_tool_call")
              expect(err?.message).toContain("target")
              expect(err?.message).not.toContain("No native AgentProtocolOutput tool call found")
              expect(JSON.stringify(inputs[1]?.system)).toContain("tool call was malformed")
              expect(last?.info.role === "assistant" ? last.info.finish : undefined).toBe("error")
              expect(
                last?.parts.some(
                  (part) =>
                    part.type === "text" &&
                    part.metadata?.kind === "protocol_malformed" &&
                    part.metadata?.action === "failed" &&
                    !part.ignored,
                ),
              ).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner allows verifier packages without worker dependencies", async () => {
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
      const body =
        calls === 1
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
    const items = [
      {
        name: "backend",
        kind: "worker",
        capability: { purpose: "implement", tags: [], writes: true },
        verification: { required: [], on_write: [], high_risk: [] },
        entry: { delegable: true },
        inheritPermissions: true,
        permission: [],
      },
      {
        name: "backend-verifier",
        kind: "verifier",
        capability: { purpose: "verify", tags: [], writes: false },
        entry: { delegable: true },
        inheritPermissions: true,
        permission: [],
      },
    ] as const
    const agent = spyOn(Agent, "get").mockImplementation(
      async (name) => items.find((item) => item.name === name) as never,
    )
    const list = spyOn(Agent, "list").mockImplementation(async () => items as never)
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
        text: `${input.agent}: completed`,
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
              const child = children.find((item) => item.agent === "backend-verifier")
              const retry = logs.find((item) => item.type === "protocol.retry")

              expect(result).toBe("stop")
              expect(calls).toBe(1)
              expect(retry).toBeUndefined()
              expect(children.some((item) => item.agent === "backend")).toBe(true)
              expect(child?.permission?.some((item) => item.permission === "bash" && item.action === "allow")).toBe(
                true,
              )
              expect(child?.permission?.some((item) => item.permission === "edit" && item.action === "deny")).toBe(
                true,
              )
              expect(
                child?.permission?.some(
                  (item) => item.permission === "bash" && item.pattern === "git reset *" && item.action === "deny",
                ),
              ).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
      agent.mockRestore()
      list.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner accepts verifier dependencies by action id, not agent target", async () => {
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
        { id: "complete_m4_e4_files", kind: "agent", target: "general-executor", prompt: "Complete M4.E4 files." },
        {
          id: "verify_m4_e4_completion",
          kind: "agent",
          target: "general-executor-verifier",
          prompt: "Verify M4.E4 completion.",
          depends: ["complete_m4_e4_files"],
        },
        { id: "finalize_m2_pipeline_doc", kind: "agent", target: "general-executor", prompt: "Finalize M2 doc." },
      ],
    }
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "tool-input-start", id: "call_1", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
            yield { type: "tool-call", toolCallId: "call_1", toolName: LLM.PROTOCOL_OUTPUT_TOOL, input: body }
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
        }) as never,
    )
    const junior = {
      name: "general-executor",
      kind: "worker",
      capability: { purpose: "implementation", tags: [], writes: false },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [],
    } as never
    const verify = {
      name: "general-executor-verifier",
      kind: "verifier",
      capability: { purpose: "review", tags: [], writes: false },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [],
    } as never
    const parent = {
      name: "protocol-runner",
      kind: "planner",
      capability: { purpose: "coordination", tags: [], writes: false },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } as never
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => {
      if (name === "general-executor") return junior
      if (name === "general-executor-verifier") return verify
      if (name === "protocol-runner") return parent
      return undefined
    })
    const list = spyOn(Agent, "list").mockImplementation(async () => [junior, verify, parent] as never)
    const provider = spyOn(Provider, "getModel").mockImplementation(async () => model)
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      const msg = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "assistant",
        mode: input.agent ?? "general-executor",
        agent: input.agent ?? "general-executor",
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
      } as MessageV2.Assistant
      return {
        info: msg,
        parts: [
          {
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: input.sessionID,
            type: "text",
            text: "kind: success\ntask_background: delegated\ncompletion_summary: done\nchanged_files: none",
            time: { start: Date.now(), end: Date.now() },
          } as MessageV2.TextPart,
        ],
      } as MessageV2.WithParts
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
                agent: { name: "protocol-runner", runner: "protocol" } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "run milestone work" }],
                tools: {},
              })
              const logs = await SessionLog.list({ sessionID: session.id })
              const children = await Session.children(session.id)

              expect(result).toBe("stop")
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(false)
              expect(children.some((item) => item.agent === "general-executor")).toBe(true)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      agent.mockRestore()
      list.mockRestore()
      provider.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner asks model to regenerate packages rejected during execution validation", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const inputs: LLM.StreamInput[] = []
    let calls = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      const body =
        calls === 1
          ? {
              version: "2",
              items: [
                {
                  id: "verify_only",
                  kind: "agent",
                  target: "verifier",
                  prompt: "Verify prior evidence.",
                  depends: ["missing_action"],
                },
              ],
            }
          : {
              version: "2",
              items: [{ id: "answer", kind: "answer", message: "Rejected package regenerated into a safe response." }],
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
    let gets = 0
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => {
      if (name !== "verifier") return undefined
      gets++
      return gets === 1 ? undefined : ({ name, kind: "verifier" } as never)
    })
    const list = spyOn(Agent, "list").mockImplementation(async () => [])
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
                messages: [{ role: "user", content: "verify evidence" }],
                tools: {},
              })
              const messages = await Session.messages({ sessionID: session.id })
              const text = messages
                .flatMap((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
                .join("\n")

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(JSON.stringify(inputs[1]?.system)).toContain("invalid dependencies")
              expect(JSON.stringify(inputs[1]?.system)).toContain("verify_only")
              expect(JSON.stringify(inputs[1]?.system)).toContain("Retry now by calling AgentProtocolOutput")
              expect(text).toContain("Rejected package regenerated into a safe response.")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      agent.mockRestore()
      list.mockRestore()
      provider.mockRestore()
    }
  })

  test.each([
    ["allows satisfying completed historical child actions", true, 1],
    ["rejects non-satisfying completed historical child actions", false, 2],
  ])("protocol runner %s", async (_, satisfying, expected) => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const inputs: LLM.StreamInput[] = []
    let calls = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      const body =
        satisfying || calls === 1
          ? {
              version: "2",
              items: [
                {
                  id: "verify_history",
                  kind: "agent",
                  target: "verifier",
                  prompt: "Verify historical worker evidence.",
                  depends: ["run_m2_e6_f5_v4_evidence"],
                },
              ],
            }
          : {
              version: "2",
              items: [{ id: "answer", kind: "answer", message: "Historical dependency was rejected." }],
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
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => {
      if (name === "verifier")
        return {
          name,
          kind: "verifier",
          capability: { purpose: "review", tags: [], writes: false },
          entry: { delegable: true },
          inheritPermissions: true,
          permission: [],
        } as never
      return undefined
    })
    const list = spyOn(Agent, "list").mockImplementation(
      async () =>
        [
          {
            name: "verifier",
            kind: "verifier",
            capability: { purpose: "review", tags: [], writes: false },
            entry: { delegable: true },
            inheritPermissions: true,
            permission: [],
          },
        ] as never,
    )
    const provider = spyOn(Provider, "getModel").mockImplementation(async () => model)
    const prompt = spyOn(SessionPrompt, "prompt")
    prompt.mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "verifier",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "verifier",
        agent: input.agent ?? "verifier",
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
      } as MessageV2.Assistant)) as MessageV2.Assistant
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "tool",
        callID: "call_verify_history",
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "verifier",
            action_id: "verify_history",
            target_action_id: "run_m2_e6_f5_v4_evidence",
            status: "success",
            result: "Historical worker evidence verified.",
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      return { info: msg, parts: [part] } as MessageV2.WithParts
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              const child = await Session.create({ parentID: session.id, agent: "backend" })
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
              await SessionResult.put({
                carrier: "action_result",
                status: "completed",
                satisfying,
                sessionID: child.id,
                parentSessionID: session.id,
                childSessionID: child.id,
                runID: "apr_history",
                actionID: "run_m2_e6_f5_v4_evidence",
                summary: "Historical evidence completed.",
                raw: {
                  action_result: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "run_m2_e6_f5_v4_evidence",
                    status: "success",
                    result: "Historical evidence completed.",
                  },
                },
              })
              await Session.setDslContext({
                sessionID: session.id,
                dsl_context: {
                  protocol: {
                    completed_delegations: [
                      {
                        type: "agent.delegation.result",
                        version: "1",
                        status: "completed",
                        run_id: "apr_history",
                        action_id: "run_m2_e6_f5_v4_evidence",
                        action_title: "Run M2 evidence",
                        parent_session_id: session.id,
                        parent_message_id: user.id,
                        parent_agent: "protocol-runner",
                        child_session_id: child.id,
                        agent: "backend",
                        result_policy: "structured",
                        satisfying,
                        completed_at: Date.now(),
                        summary:
                          "task_background: historical evidence\ncompletion_summary: completed\nchanged_files: none",
                        output:
                          "task_background: historical evidence\ncompletion_summary: completed\nchanged_files: none\nverification: tsc pass",
                      },
                    ],
                  },
                },
              })
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
                messages: [{ role: "user", content: "verify historical child" }],
                tools: {},
              })
              for (let i = 0; i < 50; i++) {
                const current = (await Session.get(session.id)).dsl_context?.protocol as
                  | { runs?: { status?: string }[] }
                  | undefined
                if (current?.runs?.[0]?.status === "completed") break
                await Bun.sleep(10)
              }
              const logs = await SessionLog.list({ sessionID: session.id })
              const children = await Session.children(session.id)
              const records = children[0] ? await Session.messages({ sessionID: children[0].id }) : []
              const messages = await Session.messages({ sessionID: session.id })
              const text = messages
                .flatMap((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
                .join("\n")

              expect(result).toBe("stop")
              expect(calls).toBe(expected)
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(!satisfying)
              expect(text).toContain(satisfying ? "Delegated to verifier" : "Historical dependency was rejected.")
              expect(
                records.some((item) =>
                  item.parts.some((part) => part.type === "tool" && part.tool === "ActionResult"),
                ),
              ).toBe(satisfying)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      agent.mockRestore()
      list.mockRestore()
      provider.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner binds confirmed task assignment before other actions", async () => {
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
        {
          id: "impl",
          kind: "tool",
          target: "read",
          args: { filePath: "package.json" },
        },
        {
          id: "confirm_plan",
          kind: "confirm",
          prompt: "Approve?",
          plan: "Run backend work.",
          assignment: {
            op: "create",
            target: "self",
          },
        },
        {
          id: "verify",
          kind: "tool",
          target: "read",
          args: { filePath: "src/index.ts" },
        },
      ],
    }
    let calls = 0
    let enter = () => {}
    let release = () => {}
    const entered = new Promise<void>((resolve) => (enter = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      const input =
        calls === 1
          ? body
          : {
              version: "2",
              items: [{ id: "answer", kind: "answer", message: "Backend work completed." }],
            }
      return {
        fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "tool-input-start", id: "call_1", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
            yield {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input,
            }
            yield {
              type: "tool-result",
              toolCallId: "call_1",
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
                runtimeTools: {
                  catalog: [
                    {
                      id: "read",
                      description: "Read file",
                      schema: {
                        type: "object",
                        properties: { filePath: { type: "string" } },
                        required: ["filePath"],
                      },
                    },
                  ],
                  prompt: "",
                  execute: async () => {
                    enter()
                    await blocked
                    return { title: "read", output: "ok", metadata: {} }
                  },
                } as never,
              })

              await poll(async () => (await Question.list()).length > 0)
              const questions = await Question.list()

              const children = await Session.children(session.id)
              const after = await Session.get(session.id)
              const protocol = after.dsl_context?.protocol as { confirmations?: { status: string }[] } | undefined

              expect(children).toHaveLength(0)
              expect(questions).toHaveLength(1)
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              expect(questions[0]?.tool?.callID).toBe("call_confirm_plan")
              expect(protocol?.confirmations?.[0]?.status).toBe("pending")

              await Question.reply({
                requestID: questions[0]!.id,
                answers: [["Confirm"]],
                response: "confirm",
              })
              await entered
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              expect(await SessionTask.current(session.id)).toMatchObject({
                title: "confirm_plan",
                body: "Run backend work.",
                version: 1,
              })
              const pending = await Session.get(session.id)
              const pendingProtocol = pending.dsl_context?.protocol as { runs?: { status?: string }[] } | undefined
              const active = await SessionLog.list({ sessionID: session.id })
              const lifecycle = active.filter((item) =>
                [
                  "protocol.started",
                  "protocol.action.completed",
                  "protocol.action.failed",
                  "protocol.completed",
                  "protocol.failed",
                ].includes(item.type),
              )
              expect(pendingProtocol?.runs?.[0]?.status).toBe("running")
              expect(lifecycle.map((item) => item.type)).toEqual(["protocol.started"])
              release()
              await run
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(1)
              const done = await SessionLog.list({ sessionID: session.id })
              expect(done.filter((item) => item.type === "protocol.validated")).toHaveLength(1)
              const events = done
                .filter((item) =>
                  [
                    "protocol.started",
                    "protocol.action.completed",
                    "protocol.action.failed",
                    "protocol.completed",
                    "protocol.failed",
                  ].includes(item.type),
                )
                .map((item) => item.type)
              expect(events).toEqual([
                "protocol.started",
                "protocol.action.completed",
                "protocol.action.completed",
                "protocol.action.completed",
                "protocol.completed",
              ])
            },
          }),
      })
    } finally {
      stream.mockRestore()
      provider.mockRestore()
    }
  })

  test("protocol runner creates assignment from confirmed plan", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const plan = "Goal: persist assignments from confirmation.\nScope: use confirm.plan as the assignment content."
    let calls = 0
    const inputs: LLM.StreamInput[] = []
    const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      inputs.push(input)
      const body =
        calls === 1
          ? {
              version: "2",
              items: [
                {
                  id: "confirm_assignment",
                  kind: "confirm",
                  title: "Confirm assignment",
                  prompt: "Confirm this assignment.",
                  plan,
                  assignment: {
                    op: "create",
                    target: "self",
                  },
                },
              ],
            }
          : {
              version: "2",
              items: [
                {
                  id: "answer",
                  kind: "answer",
                  message: "Assignment confirmed.",
                },
              ],
            }
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_assignment_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_assignment_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input: body,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_assignment_${calls}`,
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
                messages: [{ role: "user", content: "create assignment" }],
                tools: {},
              })

              await poll(async () => (await Question.list()).length > 0)
              const questions = await Question.list()

              expect(questions).toHaveLength(1)
              await Question.reply({
                requestID: questions[0]!.id,
                answers: [["Confirm"]],
                response: "confirm",
              })
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              expect(await SessionTask.get(session.id)).toBeUndefined()
              await run
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              expect(await SessionTask.get(session.id)).toBeUndefined()

              const item = await SessionAssignment.active(session.id)
              expect(item?.title).toBe("Confirm assignment")
              expect(item?.status).toBe("running")
              const content = (await SessionAssignment.content(item!.id)) as { plan?: string }
              expect(content.plan).toBe(plan)
              expect(content).toMatchObject({ assignment: { op: "create", target: "self" } })

              const msgs = await MessageV2.filterCompacted(MessageV2.stream(session.id))
              const record = msgs.find(
                (msg) =>
                  msg.info.role === "user" &&
                  msg.info.id !== user.id &&
                  msg.parts.some((part) => part.type === "text" && part.text.includes("User choice: Confirm")),
              )
              if (!record || record.info.role !== "user") throw new Error("expected confirmation response history")
              expect(SessionTurn.get(record.info)?.status).toBe("done")
              expect(record.parts.some((part) => part.type === "text" && part.text.includes(plan))).toBe(true)
              expect(JSON.stringify(inputs[1]?.messages)).toContain("Protocol confirmation response")
              expect(JSON.stringify(inputs[1]?.messages)).toContain("User choice: Confirm")

              const fresh = await MessageV2.get({ sessionID: session.id, messageID: user.id })
              if (fresh.info.role !== "user") throw new Error("expected original user message")
              expect(SessionTurn.get(fresh.info)?.status).toBe("done")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      provider.mockRestore()
    }
  })

  test("protocol runner rejects confirm and agent packages before creating a run or child", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let calls = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      const body =
        calls === 1
          ? {
              version: "2",
              items: [
                {
                  id: "confirm_plan_v2",
                  kind: "confirm",
                  prompt: "Confirm the plan.",
                  plan: "Run backend implementation and verifier after confirmation.",
                },
                {
                  id: "implement_plan_v2",
                  kind: "agent",
                  target: "backend",
                  prompt: "Implement the confirmed plan.",
                },
              ],
            }
          : {
              version: "2",
              items: [
                {
                  id: "answer",
                  kind: "answer",
                  message: "Regenerated confirm-only package into a safe response.",
                },
              ],
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
                messages: [{ role: "user", content: "confirm and execute plan" }],
                tools: {},
              })

              await poll(async () => (await Question.list()).length > 0)
              const questions = await Question.list()
              const logs = await SessionLog.list({ sessionID: session.id })
              const retry = logs.find((item) => item.type === "protocol.retry")

              expect(calls).toBe(1)
              expect(questions).toHaveLength(1)
              expect(retry).toBeUndefined()
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              expect(await Session.children(session.id)).toHaveLength(0)
              const pending = await SessionLog.list({ sessionID: session.id })
              expect(pending.filter((item) => item.data.runID)).toHaveLength(0)

              await Question.reject(questions[0]!.id).catch(() => {})
              await run.catch(() => undefined)
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              expect(await Session.children(session.id)).toHaveLength(0)
              const done = await SessionLog.list({ sessionID: session.id })
              expect(done.filter((item) => item.data.runID)).toHaveLength(0)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      provider.mockRestore()
    }
  })

  test("protocol runner expands form input fields into selectable questions", async () => {
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
        {
          id: "resolve_path_and_contracts",
          kind: "input",
          title: "Resolve path and provide contracts",
          prompt: "Choose the path and contracts.",
          mode: "form",
          fields: [
            {
              id: "history_path",
              label: "history.ts path",
              type: "single",
              options: [
                { id: "src_visual_state", label: "src/visual-state/history.ts", description: "Create src path." },
                { id: "packages_visual_editor", label: "packages/visual-editor/src/visual-state/history.ts" },
              ],
            },
            {
              id: "branching_policy",
              label: "Branching policy",
              type: "single",
              options: [
                { id: "truncate_redo", label: "Truncate redo branch" },
                { id: "keep_redo", label: "Keep redo branch" },
              ],
            },
          ],
        },
      ],
    }
    const done = {
      version: "2",
      items: [
        {
          id: "success",
          kind: "success",
          message: "Proceeding with the selected path and policy.",
        },
      ],
    }
    let calls = 0
    const systems: string[] = []
    const stream = spyOn(LLM, "stream").mockImplementation(async (req) => {
      calls++
      systems.push((req.system ?? []).join("\n"))
      const input = calls === 1 ? body : done
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: `call_${calls}`, toolName: LLM.PROTOCOL_OUTPUT_TOOL }
          yield {
            type: "tool-call",
            toolCallId: `call_${calls}`,
            toolName: LLM.PROTOCOL_OUTPUT_TOOL,
            input,
          }
          yield {
            type: "tool-result",
            toolCallId: `call_${calls}`,
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
                messages: [{ role: "user", content: "choose path" }],
                tools: {},
              })

              await poll(async () => (await Question.list()).length > 0)
              const questions = await Question.list()

              expect(questions).toHaveLength(1)
              expect(questions[0]?.questions).toHaveLength(2)
              expect(questions[0]?.questions[0]?.header).toBe("history.ts path")
              expect(questions[0]?.questions[0]?.options.map((item) => item.label)).toEqual([
                "src/visual-state/history.ts",
                "packages/visual-editor/src/visual-state/history.ts",
              ])
              expect(questions[0]?.questions[1]?.header).toBe("Branching policy")
              const pending = await Session.get(session.id)
              const pendingProtocol = pending.dsl_context?.protocol as
                | { inputs?: { action_id?: string; questions?: unknown[]; status?: string }[] }
                | undefined
              expect(pendingProtocol?.inputs?.[0]?.action_id).toBe("resolve_path_and_contracts")
              expect(pendingProtocol?.inputs?.[0]?.status).toBe("pending")
              expect(pendingProtocol?.inputs?.[0]?.questions).toHaveLength(2)
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)

              await Question.reply({
                requestID: questions[0]!.id,
                answers: [["src/visual-state/history.ts"], ["Truncate redo branch"]],
              })
              expect(await run).toBe("stop")

              const messages = await Session.messages({ sessionID: session.id })
              const text = messages
                .flatMap((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
                .join("\n")
              const summary = messages
                .flatMap((item) => item.parts)
                .find((part) => part.type === "text" && part.metadata?.kind === "protocol_summary")
              const doneSession = await Session.get(session.id)
              const doneProtocol = doneSession.dsl_context?.protocol as
                | { inputs?: { action_id?: string; answers?: string[][]; status?: string }[] }
                | undefined
              expect(calls).toBe(2)
              expect(systems[1]).toContain("Use an `answer` item")
              expect(systems[1]).toContain("Use a `done` item")
              expect(systems[1]).toContain("Resolved user input from the previous runtime interaction:")
              expect(systems[1]).toContain("Input action: resolve_path_and_contracts")
              expect(systems[1]).toContain("Question: Choose the path and contracts.")
              expect(systems[1]).toContain('selected: src_visual_state ("src/visual-state/history.ts")')
              expect(systems[1]).toContain("description: Create src path.")
              expect(systems[1]).toContain('selected: truncate_redo ("Truncate redo branch")')
              expect(systems[1]).toContain("Treat the selected option(s), custom answer(s), and provided text above")
              expect(doneProtocol?.inputs?.[0]?.status).toBe("answered")
              expect(doneProtocol?.inputs?.[0]?.answers).toEqual([
                ["src/visual-state/history.ts"],
                ["Truncate redo branch"],
              ])
              expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
              const logs = await SessionLog.list({ sessionID: session.id })
              const lifecycle = logs.filter(
                (item) =>
                  item.data.runID &&
                  (item.type === "protocol.started" ||
                    item.type.startsWith("protocol.action.") ||
                    item.type === "protocol.completed" ||
                    item.type === "protocol.failed" ||
                    item.type === "protocol.validated"),
              )
              expect(lifecycle).toHaveLength(0)
              expect(summary?.type === "text" ? summary.metadata?.action : undefined).toBe("input_received")
              expect(text).toContain("Protocol input received: Resolve path and provide contracts")
              expect(text).toContain("- Resolve path and provide contracts: input received")
              expect(text).toContain("Proceeding with the selected path and policy.")
              expect(text).not.toContain("Protocol blocked: Resolve path and provide contracts")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      provider.mockRestore()
    }
  })

  test("protocol runner starts verifier after a satisfying worker handoff", async () => {
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
        {
          id: "verify",
          kind: "agent",
          target: "loose-verifier",
          prompt: "Verify backend change.",
          depends: ["impl"],
        },
      ],
    }
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
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
        }) as never,
    )
    const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
      const verifier = input.agent === "loose-verifier"
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "tool",
        callID: verifier ? "call_verify" : "call_impl",
        tool: "ActionResult",
        state: {
          status: "completed",
          input: verifier
            ? {
                kind: "action_result",
                role: "verifier",
                action_id: "verify",
                target_action_id: "impl",
                status: "success",
                result: "Backend change verified.",
              }
            : {
                kind: "action_result",
                role: "worker",
                action_id: "impl",
                status: "success",
                result: "Backend change implemented.",
              },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)
    const items = [
      {
        name: "backend",
        kind: "worker",
        capability: { purpose: "implement", tags: [], writes: true },
        verification: { required: [], on_write: [], high_risk: [] },
        entry: { delegable: true },
        inheritPermissions: true,
        permission: [],
      },
      {
        name: "loose-verifier",
        kind: "verifier",
        capability: { purpose: "verify", tags: [], writes: false },
        entry: { delegable: true },
        inheritPermissions: true,
        permission: [],
      },
    ] as const
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => items.find((item) => item.name === name) as never)
    const list = spyOn(Agent, "list").mockImplementation(async () => items as never)

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
              for (let i = 0; i < 50; i++) {
                const current = (await Session.get(session.id)).dsl_context?.protocol as
                  | { runs?: { status?: string }[] }
                  | undefined
                if (current?.runs?.[0]?.status === "completed") break
                await Bun.sleep(10)
              }
              const children = await Session.children(session.id)

              expect(result).toBe("stop")
              expect(children).toHaveLength(1)
              expect(children[0]?.title).toContain("@backend")
              expect(inputs[0]?.agent).toBe("backend")
              expect(inputs[1]?.agent).toBe("loose-verifier")
              const verifiers = await Session.children(children[0]!.id)
              expect(verifiers).toHaveLength(1)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
      agent.mockRestore()
      list.mockRestore()
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
        type: "tool",
        callID: "call_update_toolbar_backend",
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "worker",
            action_id: "update_toolbar_backend",
            status: "success",
            result: "Child agent reviewed toolbar buttons.",
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      done++
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)
    const worker = {
      name: "backend",
      kind: "worker",
      capability: { purpose: "implement", tags: [], writes: true },
      verification: { required: [], on_write: [], high_risk: [] },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [],
    } as const
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => (name === worker.name ? worker : undefined) as never)
    const list = spyOn(Agent, "list").mockImplementation(async () => [worker] as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Session.setModel({
                sessionID: session.id,
                model: {
                  providerID: ProviderID.make("minimax-cn-coding-plan"),
                  modelID: ModelID.make("MiniMax-M3"),
                },
              })
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
                model: {
                  providerID: ProviderID.make("deepseek"),
                  modelID: ModelID.make("deepseek-v4-flash"),
                },
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
              const protocol = after.dsl_context?.protocol as
                | {
                    runs?: { actions: { output?: string }[] }[]
                  }
                | undefined
              expect(result).toBe("stop")
              expect(children).toHaveLength(1)
              expect(children[0]?.parentID).toBe(session.id)
              expect(children[0]?.title).toContain("Protocol: update_toolbar_backend")
              const child = await Session.get(children[0]!.id)
              expect(JSON.stringify(child.dsl_context)).toContain("agent.delegation.assignment")
              expect(child.agent).toBe("backend")
              expect(child.model).toEqual({
                providerID: ProviderID.make("minimax-cn-coding-plan"),
                modelID: ModelID.make("MiniMax-M3"),
              })
              expect(child.dsl_context).not.toHaveProperty("session_tree")
              expect(JSON.stringify(child.dsl_context)).toContain('"parent_session_id"')
              expect(JSON.stringify(protocol?.runs?.[0]?.actions[0])).toContain(
                "The parent session will resume automatically",
              )
              await poll(() => done >= 2)
              expect(done).toBeGreaterThanOrEqual(2)
              expect(inputs[0]?.agent).toBe("backend")
              expect(inputs[0]?.model).toEqual({
                providerID: ProviderID.make("minimax-cn-coding-plan"),
                modelID: ModelID.make("MiniMax-M3"),
              })
              const resume = inputs.find((item) => item.agent === "protocol-runner")
              expect(resume?.agent).toBe("protocol-runner")
              expect(
                resume?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("Delegated child sessions have finished"),
                ),
              ).toBe(true)
              expect(
                resume?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("`update_toolbar_backend`"),
                ),
              ).toBe(true)
              expect(inputs[0]?.parts?.some((part) => part.type === "agent")).toBe(false)
              const text = inputs[0]?.parts?.map((part) => (part.type === "text" ? part.text : "")).join("\n")
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
      agent.mockRestore()
      list.mockRestore()
    }
  })

  test("compensates delegated child state when task binding fails", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const body = {
      version: "2",
      items: [{ id: "delegate_bind_fail", kind: "agent", target: "backend", prompt: "Delegate work" }],
    }
    let calls = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async () =>
      packet(
        calls++ === 0 ? body : { version: "2", items: [{ id: "answer", kind: "answer", message: "Stopped." }] },
        `call_bind_fail_${calls}`,
      ),
    )
    const worker = {
      name: "backend",
      kind: "worker",
      capability: { purpose: "implement", tags: [], writes: true },
      verification: { required: [], on_write: [], high_risk: [] },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [],
    } as const
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => (name === worker.name ? worker : undefined) as never)
    const list = spyOn(Agent, "list").mockImplementation(async () => [worker] as never)
    const bind = spyOn(SessionTask, "beginDelegated").mockRejectedValue(
      new SessionTask.Conflict("session_task_delegation_assignment_conflict"),
    )
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
                agent: { name: "protocol-runner", runner: "protocol" } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "delegate work" }],
                tools: {},
              })

              const children = await Session.children(session.id)
              expect(children).toHaveLength(1)
              const child = children[0]!
              const parent = await Session.get(session.id)
              const protocol = parent.dsl_context?.protocol as
                | { pending_delegations?: Record<string, unknown>; runs?: { run_id?: string }[] }
                | undefined
              const info = await Session.get(child.id)
              const delegation = info.dsl_context?.protocol as { delegation?: { run_id?: string } } | undefined
              expect(await SessionAssignment.active(child.id)).toBeUndefined()
              expect(
                (
                  await SessionAssignment.bySource({
                    sessionID: session.id,
                    runID: delegation?.delegation?.run_id,
                    actionID: "delegate_bind_fail",
                  })
                )?.status,
              ).toBe("failed")
              expect(Object.keys(protocol?.pending_delegations ?? {})).toHaveLength(0)
              expect(["failed", "error", "aborted"]).toContain(SessionStatus.get(child.id).type)
              expect(await SessionTask.get(child.id)).toBeUndefined()
            },
          }),
      })
    } finally {
      stream.mockRestore()
      agent.mockRestore()
      list.mockRestore()
      bind.mockRestore()
    }
  })

  test("protocol child sessions inherit parent model when agent has no model", async () => {
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
          id: "inherit_model_backend",
          type: "agent",
          name: "backend",
          args: { prompt: "Check inherited model" },
          result: "summary",
        },
      ],
    }
    let calls = 0
    let done = 0
    const stream = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Delegated work completed." }
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
        text: "child done",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      done++
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)
    const worker = {
      name: "backend",
      kind: "worker",
      capability: { purpose: "implement", tags: [], writes: true },
      verification: { required: [], on_write: [], high_risk: [] },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [],
    } as const
    const agent = spyOn(Agent, "get").mockImplementation(async (name) => (name === worker.name ? worker : undefined) as never)
    const list = spyOn(Agent, "list").mockImplementation(async () => [worker] as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              })
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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

              expect(
                await runner.process({
                  user,
                  sessionID: session.id,
                  model,
                  agent: { name: "protocol-runner", runner: "protocol" } as never,
                  system: [],
                  abort: new AbortController().signal,
                  messages: [{ role: "user", content: "delegate review" }],
                  tools: {},
                }),
              ).toBe("stop")
              const child = (await Session.children(session.id))[0]

              expect(child?.agent).toBe("backend")
              expect(child?.model).toEqual({
                providerID: ProviderID.make("openai"),
                modelID: ModelID.make("gpt-5.2"),
              })
              await poll(() => done >= 1)
              expect(done).toBeGreaterThanOrEqual(1)
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
      agent.mockRestore()
      list.mockRestore()
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
        version: "2",
        items: [
          { id: "old", kind: "success", message: "Inspection complete." },
          {
            id: "feat_dirty_tracking",
            kind: "agent",
            target: "backend",
            prompt: "Implement dirty tracking backend state.",
            depends: ["missing"],
          },
        ],
      },
      {
        version: "2",
        items: [
          { id: "old", kind: "success", message: "Inspection complete." },
          {
            id: "feat_dirty_tracking",
            kind: "agent",
            target: "backend",
            prompt: "Implement dirty tracking backend state.",
          },
        ],
      },
    ]
    let calls = 0
    let early: string | undefined
    let target: SessionID | undefined
    const systems: string[] = []
    const stream = spyOn(LLM, "stream").mockImplementation(async (req) => {
      systems.push(req.system.join("\n"))
      if (calls === 2 && target) early = (await SessionRuns.list(target))[0]?.summary
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
        type: "tool",
        callID: "call_feat_dirty_tracking",
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "worker",
            action_id: "feat_dirty_tracking",
            status: "success",
            result: "Dirty tracking backend state completed.",
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)
    const feature = {
      name: "feature-planner",
      kind: "planner",
      mode: "primary",
      runner: "protocol",
      capability: { purpose: "plan", tags: [], writes: false },
      verification: { required: [], on_write: [], high_risk: [] },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "allow" },
      ],
      options: {},
    } as never
    const worker = {
      name: "backend",
      kind: "worker",
      capability: { purpose: "implement", tags: [], writes: true },
      verification: { required: [], on_write: [], high_risk: [] },
      entry: { delegable: true },
      inheritPermissions: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } as const
    const get = spyOn(Agent, "get").mockImplementation(async (name) => {
      if (name === worker.name) return worker as never
      if (name === "feature-planner") return feature
    })
    const list = spyOn(Agent, "list").mockImplementation(async () => [feature, worker] as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
              const session = await Session.create({})
              target = session.id
              await Session.setPermission({
                sessionID: session.id,
                permission: [
                  { permission: "read", pattern: "*", action: "allow" },
                  { permission: "task", pattern: "*", action: "allow" },
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
              const result = await runner.process({
                user,
                sessionID: session.id,
                model,
                agent: feature,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "inspect then decide next work" }],
                tools: {},
              })
              await poll(async () => (await Session.children(session.id)).length > 0)
              const children = await Session.children(session.id)
              const messages = await Session.messages({ sessionID: session.id, limit: 10 })
              const text = messages
                .flatMap((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
                .join("\n")

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(early).toBeUndefined()
              expect(systems[2]).toContain("missing")
              expect(systems[2]).toContain("depends")
              expect(systems[2]).toContain("regenerated package")
              expect(children).toHaveLength(1)
              expect(children[0]?.title).toContain("Protocol: feat_dirty_tracking (@backend)")
              expect(text).toContain("The parent session will resume automatically")
              expect(text).not.toContain("Protocol agent denied: backend")
              expect(text).not.toContain("Protocol final response was empty or malformed.")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
      get.mockRestore()
      list.mockRestore()
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
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
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
        }) as never,
    )
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
        type: "tool",
        callID: "call_plan_protocol_tasks",
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "worker",
            action_id: "plan_protocol_tasks",
            status: "success",
            result: `agent:${input.agent} completed`,
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
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

              expect(result).toBe("stop")
              expect(children).toHaveLength(1)
              expect(children[0]?.title).toContain("@general-investigator")
              await poll(() => done >= 2)
              expect(done).toBeGreaterThanOrEqual(2)
              expect(inputs[0]?.agent).toBe("general-investigator")
              expect(inputs[1]?.agent).toBe("default")
              const text = inputs[0]?.parts?.map((part) => (part.type === "text" ? part.text : "")).join("\n")
              expect(text).not.toContain("@default")
            },
          }),
      })
    } finally {
      stream.mockRestore()
      prompt.mockRestore()
    }
  })

  test("protocol runner fails unavailable agent without creating child session", async () => {
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
          id: "dispatch_removed_agent",
          kind: "agent",
          target: "hephaestus",
          prompt: "Implement the bounded task.",
        },
      ],
    }
    const hook = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
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
        }) as never,
    )

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
                messages: [{ role: "user", content: "dispatch removed agent" }],
                tools: {},
              })
              const sessionAfter = await Session.get(session.id)
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: { status: string; actions: { status: string; error?: string }[] }[]
                  }
                | undefined
              const fresh = await MessageV2.get({ sessionID: session.id, messageID: user.id })
              if (fresh.info.role !== "user") throw new Error("expected user message")
              const turn = SessionTurn.get(fresh.info)

              expect(result).toBe("stop")
              expect(await Session.children(session.id)).toHaveLength(0)
              expect(protocol?.runs?.at(-1)?.status).toBe("failed")
              expect(protocol?.runs?.at(-1)?.actions[0]?.status).toBe("failed")
              expect(protocol?.runs?.at(-1)?.actions[0]?.error).toContain("Protocol agent not found: hephaestus")
              expect(turn?.outcome).toBe("failed")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("prompt finish ignores stale interrupted pending child after protocol failure", async () => {
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
          id: "dispatch_removed_agent",
          kind: "agent",
          target: "hephaestus",
          prompt: "Implement the bounded task.",
        },
      ],
    }
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
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
        }) as never,
    )
    const provider = spyOn(Provider, "getModel").mockImplementation(async () => model)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({ agent: "default" })
              const child = await Session.create({ parentID: session.id, agent: "general-executor" })
              SessionStatus.set(child.id, {
                type: "interrupted",
                prior: "running",
                message: "Session was running when the process stopped.",
              })
              await Session.setDslContext({
                sessionID: session.id,
                dsl_context: {
                  protocol: {
                    current: "apr_old",
                    pending_delegations: {
                      [child.id]: {
                        type: "agent.delegation.assignment",
                        version: "1",
                        run_id: "apr_old",
                        action_id: "old_child",
                        action_title: "Old child",
                        parent_session_id: session.id,
                        parent_message_id: "msg_old",
                        child_session_id: child.id,
                        agent: "general-executor",
                      },
                    },
                  },
                },
              })
              await SessionPrompt.prompt({
                sessionID: session.id,
                agent: "default",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                parts: [{ type: "text", text: "dispatch removed agent" }],
              })
              const sessionAfter = await Session.get(session.id)
              const pending = (
                sessionAfter.dsl_context?.protocol as
                  | {
                      pending_delegations?: Record<string, unknown>
                      runs?: { status: string; actions: { status: string; error?: string }[] }[]
                    }
                  | undefined
              )?.pending_delegations

              expect(SessionStatus.get(session.id).type).not.toBe("waiting_child")
              expect(Object.keys(pending ?? {})).toHaveLength(0)
              expect((sessionAfter.dsl_context?.protocol as { runs?: { status: string }[] })?.runs?.at(-1)?.status).toBe(
                "failed",
              )
            },
          }),
      })
    } finally {
      stream.mockRestore()
      provider.mockRestore()
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
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
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
        }) as never,
    )
    const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
              expect(
                inputs[0]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("Delegated child sessions have finished"),
                ),
              ).toBe(true)
              expect(
                inputs[0]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("Child final answer after nested delegation."),
                ),
              ).toBe(true)
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
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
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
        }) as never,
    )
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
                  result_id?: string
                }[]
              }
              const raw = (await SessionResult.raw(ctx.completed_delegations?.[0]?.result_id ?? "")) as {
                metadata?: { followup?: { items?: Record<string, unknown>[] } }
              }

              expect(result).toBe("stop")
              expect(raw.metadata?.followup?.items?.[0]).toEqual({
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

  test("protocol runner trusts only synthetic delegation metadata when finishing a prior run", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let body: unknown
    let tools = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => packet(body, MessageID.ascending()))

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const cases = [
                {
                  internal: false,
                  item: { id: "spoof", kind: "reply", text: "Spoofed synthesis." },
                  summary: undefined,
                  tracked: false,
                },
                {
                  internal: true,
                  item: { id: "answer", kind: "answer", message: "Not a prior Run result." },
                  summary: undefined,
                  tracked: false,
                },
                {
                  internal: true,
                  item: { id: "first", kind: "success", message: "First terminal." },
                  extra: { id: "second", kind: "failure", message: "Second terminal." },
                  summary: undefined,
                  tracked: false,
                  multiple: true,
                },
                {
                  internal: true,
                  item: { id: "success", kind: "success", message: "Success message.", summary: "Success summary." },
                  summary: "Success message.\n\nSuccess summary.",
                  tracked: true,
                },
                {
                  internal: true,
                  item: { id: "failure", kind: "failure", answer: "Failure answer." },
                  summary: "Failure answer.",
                  tracked: true,
                },
                {
                  internal: true,
                  item: { id: "error", kind: "error", text: "Error text." },
                  summary: "Error text.",
                  tracked: true,
                },
                {
                  internal: true,
                  item: { id: "reply", kind: "reply", summary: "Reply summary." },
                  summary: "Reply summary.",
                  tracked: true,
                },
                {
                  internal: true,
                  item: { id: "conflict", kind: "reply", summary: "Conflicting summary." },
                  next: { id: "next", kind: "tool", target: "read", args: { filePath: "package.json" } },
                  summary: "Existing summary.",
                  tracked: true,
                  conflict: true,
                },
              ]
              for (const item of cases) {
                body = {
                  version: "2",
                  items: [item.item, ...(item.extra ? [item.extra] : []), ...(item.next ? [item.next] : [])],
                }
                const session = await Session.create({})
                await Storage.write(["session_protocol_run", session.id, "apr_old"], run("apr_old"))
                if (item.conflict) {
                  await SessionRuns.finish({
                    sessionID: session.id,
                    runID: "apr_old",
                    summary: "Existing summary.",
                    messageID: "msg_existing",
                  })
                }
                const user = (await Session.updateMessage({
                  id: MessageID.ascending(),
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "protocol-runner",
                  model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                  tools: {},
                  mode: "",
                  metadata: { internal: item.internal, source: "delegation", run_id: "apr_old" },
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
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("gpt-5.2"),
                  providerID: ProviderID.make("openai"),
                  time: { created: Date.now() },
                })) as MessageV2.Assistant
                await SessionRunner.create({
                  assistantMessage: assistant,
                  sessionID: session.id,
                  model,
                  abort: new AbortController().signal,
                }).process({
                  user,
                  sessionID: session.id,
                  model,
                  agent: { name: "protocol-runner", runner: "protocol" } as never,
                  system: [],
                  abort: new AbortController().signal,
                  messages: [{ role: "user", content: "delegation results" }],
                  tools: {},
                  runtimeTools: {
                    catalog: [{ id: "read", description: "read", schema: { type: "object" } }],
                    prompt: "",
                    execute: async () => {
                      tools++
                      return { title: "read", output: "{}", metadata: {} }
                    },
                  } as never,
                })
                const runs = await SessionRuns.list(session.id)
                const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
                const outcome = await Storage.read([
                  "session_protocol_run_outcome",
                  session.id,
                  "apr_old",
                ]).catch(() => undefined)
                expect(runs.find((run) => run.run_id === "apr_old")?.summary).toBe(item.summary)
                expect(runs).toHaveLength(1)
                expect(outcome !== undefined).toBe(item.tracked)
                if (item.multiple) {
                  expect(logs.some((log) => log.type === "protocol.retry")).toBe(true)
                  expect(logs.some((log) => log.type === "protocol.malformed")).toBe(true)
                }
              }
              expect(tools).toBe(0)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner repairs executable follow-up packages with a reversed prior terminal result", async () => {
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
        { id: "next", kind: "tool", target: "read", args: { filePath: "package.json" } },
        { id: "old", kind: "success", message: "Previous Run complete." },
      ],
    }
    const inputs: LLM.StreamInput[] = []
    let calls = 0
    let tools = 0
    let target: SessionID | undefined
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      if (input.sessionID !== target) {
        return packet(
          { version: "2", items: [{ id: "background", kind: "answer", message: "Background complete." }] },
          MessageID.ascending(),
        )
      }
      inputs.push(input)
      calls++
      return packet(body, `call_missing_${calls}`)
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              target = session.id
              await Storage.write(["session_protocol_run", session.id, "apr_old"], run("apr_old"))
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
                metadata: { internal: true, source: "delegation", run_id: "apr_old" },
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              await SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              }).process({
                user,
                sessionID: session.id,
                model,
                agent: { name: "protocol-runner", runner: "protocol" } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "delegation results" }],
                tools: {},
                runtimeTools: {
                  catalog: [],
                  prompt: "",
                  execute: async () => {
                    tools++
                    return { title: "read", output: "unexpected", metadata: {} }
                  },
                } as never,
              })
              const runs = await SessionRuns.list(session.id)
              const prompt = inputs[1]?.system.join("\n") ?? ""

              expect(calls).toBe(2)
              expect(tools).toBe(0)
              expect(runs).toHaveLength(1)
              expect(runs[0]?.summary).toBeUndefined()
              expect(prompt).toContain("previous Run")
              expect(prompt).toContain("success/failure/error/reply")
              expect(prompt).toContain("new executable items")
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner finishes a prior run only after executable package validation succeeds", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let sessionID = ""
    let early: unknown
    let calls = 0
    let tools = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        early = await Storage.read(["session_protocol_run_outcome", sessionID, "apr_old"]).catch(() => undefined)
      }
      const body =
        calls === 1
          ? {
              version: "2",
              items: [
                { id: "old", kind: "success", message: "Invalid early synthesis." },
                {
                  id: "next",
                  kind: "tool",
                  target: "read",
                  args: { filePath: "package.json" },
                  depends: ["missing_action"],
                },
              ],
            }
          : calls === 2
            ? {
                version: "2",
                items: [
                  { id: "old", kind: "success", message: "Accepted synthesis." },
                  { id: "next", kind: "tool", target: "read", args: { filePath: "package.json" } },
                ],
              }
            : { version: "2", items: [{ id: "next_result", kind: "answer", message: "New run synthesis." }] }
      return packet(body, `call_validation_${calls}`)
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              sessionID = session.id
              await Storage.write(["session_protocol_run", session.id, "apr_old"], run("apr_old"))
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
                metadata: { internal: true, source: "delegation", run_id: "apr_old" },
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              const result = await SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              })
                .process({
                  user,
                  sessionID: session.id,
                  model,
                  agent: { name: "protocol-runner", runner: "protocol" } as never,
                  system: [],
                  abort: new AbortController().signal,
                  messages: [{ role: "user", content: "delegation results" }],
                  tools: {},
                  runtimeTools: {
                    catalog: [
                      {
                        id: "read",
                        description: "Read a file",
                        schema: { type: "object", properties: { filePath: { type: "string" } } },
                      },
                    ],
                    prompt: "",
                    execute: async () => {
                      tools++
                      return { title: "read", output: "{}", metadata: {} }
                    },
                  } as never,
                })
                .catch((err) => err)
              const outcome = (await Storage.read([
                "session_protocol_run_outcome",
                session.id,
                "apr_old",
              ])) as { summary: string; message_id: string }
              const messages = await Session.messages({ sessionID: session.id })
              const assistants = messages.filter((item) => item.info.role === "assistant")
              const runs = await SessionRuns.list(session.id)

              expect(result).toBe("stop")
              expect(early).toBeUndefined()
              expect(tools).toBe(1)
              expect(outcome.summary).toBe("Accepted synthesis.")
              expect(outcome.message_id).toBe(assistants[1]?.info.id)
              expect(runs).toHaveLength(2)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner finishes the prior run before creating a new run from the same package", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), "{}")
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const next = { id: "next", kind: "tool", target: "read", args: { filePath: "package.json" } }
    let calls = 0
    let tools = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      return packet(
        calls === 1
          ? {
              version: "2",
              items: [
                { id: "old_result", kind: "success", message: "Old run synthesized.", summary: "Verified." },
                next,
              ],
            }
          : { version: "2", items: [next] },
        `call_split_${calls}`,
      )
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              await Storage.write(["session_protocol_run", session.id, "apr_old"], run("apr_old"))
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
                metadata: { internal: true, source: "delegation", run_id: "apr_old" },
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              await SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              }).process({
                user,
                sessionID: session.id,
                model,
                agent: { name: "protocol-runner", runner: "protocol" } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "delegation results" }],
                tools: {},
                runtimeTools: {
                  catalog: [
                    {
                      id: "read",
                      description: "Read a file",
                      schema: { type: "object", properties: { filePath: { type: "string" } } },
                    },
                  ],
                  prompt: "",
                  execute: async () => {
                    tools++
                    return { title: "read", output: "{}", metadata: {} }
                  },
                } as never,
              })
              const runs = await SessionRuns.list(session.id)
              const old = runs.find((item) => item.run_id === "apr_old")
              const fresh = runs.find((item) => item.run_id !== "apr_old")

              expect(calls).toBe(3)
              expect(tools).toBe(1)
              expect(runs).toHaveLength(2)
              expect(old?.summary).toBe("Old run synthesized.\n\nVerified.")
              expect(fresh?.summary).toBeUndefined()
              expect(fresh?.execution_summary).toBeTruthy()
            },
          }),
      })
    } finally {
      hook.mockRestore()
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
    const counts = new Map<string, number>()
    const inputs: LLM.StreamInput[] = []
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      inputs.push(input)
      const count = (counts.get(input.sessionID) ?? 0) + 1
      counts.set(input.sessionID, count)
      if (count === 2 || count === 3) {
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
                runtimeTools: finalTools,
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
              const runs = await SessionRuns.list(session.id)
              const own = inputs.filter((item) => item.sessionID === session.id)
              const retry = own.find((item) => item.system.join("\n").includes("Protocol retry warning"))

              expect(own.some((item) => item.toolChoice === undefined)).toBe(true)
              expect(retry?.system.join("\n")).toContain("Protocol retry warning")
              expect(retry?.system.join("\n")).toContain("success/failure/error/reply")
              expect(retry?.system.join("\n")).not.toContain("a `done` item")
              expect(
                messages.some((item) =>
                  item.parts.some(
                    (part) => part.type === "text" && part.text.includes("Plain final answer.") && !part.ignored,
                  ),
                ),
              ).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.retry")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.plain" && item.data.fallback === true)).toBe(
                true,
              )
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(false)
              expect(runs).toHaveLength(1)
              expect(runs[0]?.summary).toBe("Plain final answer.")
              expect(runs[0]?.summary_source).toBe("protocol")
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
              expect(
                messages.some((item) =>
                  item.parts.some((part) => part.type === "text" && part.text.includes("Phase 1-4") && !part.ignored),
                ),
              ).toBe(true)
              expect(
                messages.every((item) =>
                  item.parts.every(
                    (part) => part.type !== "text" || part.metadata?.kind !== "protocol_malformed" || part.ignored,
                  ),
                ),
              ).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.plain")).toBe(true)
              expect(logs.some((item) => item.type === "protocol.retry")).toBe(true)
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol child session hands plain text result back to parent", async () => {
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
          yield { type: "text-delta", text: "Child task completed and docs closed." }
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "protocol-runner",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "protocol-runner",
        agent: input.agent ?? "protocol-runner",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        text: "parent resumed",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: msg, parts: [part] } as MessageV2.WithParts
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "protocol-runner" })
              const parentUser = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_plain_child",
                action_id: "plain_child",
                action_title: "Plain child",
                parent_session_id: parent.id,
                parent_message_id: parentUser.id,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "protocol-runner",
                result_policy: "summary",
                result_tool: "AgentProtocolOutput",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    pending_delegations: {
                      [child.id]: item,
                    },
                  },
                },
              })
              await Session.setDslContext({
                sessionID: child.id,
                dsl_context: {
                  protocol: {
                    delegation: item,
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
              const runner = SessionRunner.create({
                assistantMessage: assistant,
                sessionID: child.id,
                model,
                abort: new AbortController().signal,
              })
              const result = await runner.process({
                user,
                sessionID: child.id,
                model,
                agent: {
                  name: "protocol-runner",
                  runner: "protocol",
                } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "close child task" }],
                tools: {},
              })
              const rec = await SessionResult.find({
                parentSessionID: parent.id,
                childSessionID: child.id,
                runID: "apr_plain_child",
                actionID: "plain_child",
              })
              const fresh = await Session.get(parent.id)
              const ctx = fresh.dsl_context as {
                protocol?: { completed_delegations?: { child_session_id?: string; satisfying?: boolean }[] }
              }

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(rec?.carrier).toBe("plain_text_result")
              expect(rec?.status).toBe("completed")
              expect(rec?.satisfying).toBe(true)
              expect(rec?.summary).toContain("docs closed")
              expect(ctx.protocol?.completed_delegations?.[0]).toMatchObject({
                child_session_id: child.id,
                satisfying: true,
              })
              expect(prompt).toHaveBeenCalled()
            },
          }),
      })
    } finally {
      hook.mockRestore()
      prompt.mockRestore()
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
    let target: SessionID | undefined
    let failed = 0
    const emit = SessionLog.emit
    const diagnostic = spyOn(SessionLog, "emit").mockImplementation(async (input) => {
      if (input.type === "protocol.run.outcome.failed") {
        failed++
        throw new Error("diagnostic unavailable")
      }
      return emit(input)
    })
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
      if (!target) throw new Error("missing target session")
      const run = (await SessionRuns.list(target))[0]
      await Storage.write(["session_protocol_run_outcome", target, run!.run_id], { invalid: true })
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
              target = session.id
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
              expect(
                messages.some((item) =>
                  item.parts.some(
                    (part) => part.type === "text" && part.text.includes("Recovered from plain JSON answer."),
                  ),
                ),
              ).toBe(true)
              expect(logs.some((item) => item.type === "protocol.final.malformed")).toBe(false)
              expect(logs.some((item) => item.type === "protocol.final.retry")).toBe(false)
              expect(failed).toBe(1)
            },
          }),
      })
    } finally {
      hook.mockRestore()
      diagnostic.mockRestore()
    }
  })

  test("tracked final prompt requires one ordered prior Run result without repair", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    const systems: string[] = []
    let calls = 0
    let mode: "direct" | "missing" = "direct"
    const hook = spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      systems.push(input.system.join("\n"))
      if (mode === "missing" && calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "Missing native protocol output." }
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
      return packet(
        calls === 1
          ? { version: "2", items: [{ id: "read", kind: "tool", target: "read", args: { filePath: "package.json" } }] }
          : { version: "2", items: [{ id: "success", kind: "success", message: "Read complete." }] },
        `call_tracked_${calls}`,
      )
    })

    try {
      await Bun.write(path.join(tmp.path, "package.json"), "{}")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              for (const kind of ["direct", "missing"] as const) {
              mode = kind
              calls = 0
              systems.length = 0
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              const result = await SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              }).process({
                user,
                sessionID: session.id,
                model,
                agent: { name: "protocol-runner", runner: "protocol" } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "read once" }],
                tools: {},
                runtimeTools: {
                  catalog: [{ id: "read", description: "read", schema: { type: "object" } }],
                  prompt: "",
                  execute: async () => ({ title: "read", output: "{}", metadata: {} }),
                } as never,
              })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(kind === "direct" ? 2 : 3)
              expect(systems[1]).toContain("success/failure/error/reply")
              expect(systems[1]).toContain("before any new executable items")
              expect(systems[1]).not.toContain("Use an `answer` item")
              expect(systems[1]).not.toContain("Use a `done` item")
              expect(logs.some((item) => item.type === "protocol.final.retry")).toBe(kind === "missing")
              if (kind === "missing") {
                expect(systems[2]).toContain("success/failure/error/reply")
                expect(systems[2]).toContain("before any new executable items")
                expect(systems[2]).not.toContain("an `answer` item")
                expect(systems[2]).not.toContain("a `done` item")
              }
              }
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol final stops new actions when prior persistence conflicts or is corrupt", async () => {
    await using tmp = await tmpdir()
    const model = {
      id: ModelID.make("gpt-5.2"),
      providerID: ProviderID.make("openai"),
      api: { id: "openai", npm: "" },
      limit: { context: 200_000 },
    } as never
    let calls = 0
    let tools = 0
    let target: SessionID | undefined
    let mode: "conflict" | "corrupt" = "conflict"
    const read = Storage.read
    const storage = spyOn(Storage, "read").mockImplementation((async (key: string[]) => {
      if (mode === "corrupt" && calls === 1 && key[0] === "session_protocol_run" && key[1] === target) {
        return { invalid: true }
      }
      return read(key)
    }) as typeof Storage.read)
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls > 2) throw new Error(`unexpected final model call after ${mode} persistence failure`)
      if (calls === 1) {
        return packet(
          { version: "2", items: [{ id: "read", kind: "tool", target: "read", args: { filePath: "package.json" } }] },
          "call_initial",
        )
      }
      if (!target) throw new Error("missing target session")
      const old = (await SessionRuns.list(target))[0]!
      if (mode === "conflict") {
        await SessionRuns.finish({
          sessionID: target,
          runID: old.run_id,
          summary: "Existing final outcome.",
          messageID: "msg_existing_final",
        })
      }
      return packet(
        {
          version: "2",
          items: [
            { id: "old", kind: "success", message: "Conflicting final outcome." },
            { id: "next", kind: "tool", target: "glob", args: { pattern: "*.json" } },
          ],
        },
        "call_conflict",
      )
    })

    try {
      await Bun.write(path.join(tmp.path, "package.json"), "{}")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              for (const kind of ["conflict", "corrupt"] as const) {
              mode = kind
              calls = 0
              tools = 0
              const session = await Session.create({})
              target = session.id
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
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
              })) as MessageV2.Assistant
              const result = await SessionRunner.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              }).process({
                user,
                sessionID: session.id,
                model,
                agent: { name: "protocol-runner", runner: "protocol" } as never,
                system: [],
                abort: new AbortController().signal,
                messages: [{ role: "user", content: "read then continue" }],
                tools: {},
                runtimeTools: {
                  catalog: [
                    { id: "read", description: "read", schema: { type: "object" } },
                    { id: "glob", description: "glob", schema: { type: "object" } },
                  ],
                  prompt: "",
                  execute: async () => {
                    tools++
                    return { title: "runtime", output: "{}", metadata: {} }
                  },
                } as never,
              })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
              const messages = await Session.messages({ sessionID: session.id })

              expect(result).toBe("stop")
              expect(calls).toBe(kind === "conflict" ? 2 : 1)
              expect(tools).toBe(1)
              expect(
                logs.some((item) =>
                  kind === "conflict"
                    ? item.type === "protocol.run.outcome.failed"
                    : item.type === "protocol.final.malformed" && item.data.reason === "prior_run_persistence_failed",
                ),
              ).toBe(true)
              const last = messages.findLast(
                (item): item is typeof item & { info: MessageV2.Assistant } => item.info.role === "assistant",
              )
              expect(last?.info.finish).toBe("error")
              }
            },
          }),
      })
    } finally {
      hook.mockRestore()
      storage.mockRestore()
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
                runtimeTools: finalTools,
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })
              const runs = await SessionRuns.list(session.id)

              expect(result).toBe("stop")
              expect(calls).toBe(3)
              expect(inputs[2]?.system.join("\n")).toContain("Loop warning")
              expect(
                messages.some((item) =>
                  item.parts.some((part) => part.type === "text" && part.metadata?.kind === "protocol_loop_guard"),
                ),
              ).toBe(true)
              expect(logs.some((item) => item.type === "protocol.loop_guard.triggered")).toBe(true)
              expect(runs[0]?.summary).toBeUndefined()
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
      if (calls >= 3) {
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
                runtimeTools: finalTools,
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(4)
              expect(
                messages.some((item) =>
                  item.parts.some(
                    (part) => part.type === "text" && part.text.includes("Checked package and TypeScript config."),
                  ),
                ),
              ).toBe(true)
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
      if (calls >= 8) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start" }
            yield {
              type: "text-delta",
              text: "Diagnosis: still missing the exact selector. Next step: inspect the rendered DOM once.",
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
                runtimeTools: finalTools,
              })
              const messages = await Session.messages({ sessionID: session.id })
              const logs = await SessionLog.list({ sessionID: session.id, limit: 100 })

              expect(result).toBe("stop")
              expect(calls).toBe(9)
              expect(inputs.some((item) => item.system.join("\n").includes("Soft runtime limit reached"))).toBe(true)
              expect(
                messages.some((item) =>
                  item.parts.some((part) => part.type === "text" && part.text.includes("Diagnosis: still missing")),
                ),
              ).toBe(true)
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: { status: string; actions: { error?: string; output?: string; tool_call_ids: string[] }[] }[]
                  }
                | undefined
              const error = protocol?.runs?.[0]?.actions.map((item) => item.error).join("\n") ?? ""

              expect(result).toBe("stop")
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: { total: number; actions: { output?: string }[] }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(
                parts.some(
                  (part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored,
                ),
              ).toBe(true)
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: {
                      title?: string
                      status: string
                      actions: { operation: string; executor: { target: string } }[]
                    }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(protocol?.runs).toBeUndefined()
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
                '<parameter name="pattern">**/*.vsix</parameter>',
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: { status: string; actions: { output?: string; error?: string; tool_call_ids: string[] }[] }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(protocol?.runs).toBeUndefined()
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner rejects unsupported minimax AgentProtocolOutput xml", async () => {
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: {
                      status: string
                      actions: { operation: string; executor: { target: string }; output?: string; error?: string }[]
                    }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(protocol?.runs).toBeUndefined()
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner rejects unsupported minimax bare tool call xml", async () => {
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: { status: string; actions: { output?: string; error?: string; tool_call_ids: string[] }[] }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(protocol?.runs).toBeUndefined()
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("protocol runner retries noisy multi-block output before accepting a native answer", async () => {
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
    const answer = {
      version: "2",
      items: [{ id: "answer", kind: "answer", message: "Found package metadata." }],
    }
    let calls = 0
    const hook = spyOn(LLM, "stream").mockImplementation(async () => {
      calls++
      if (calls === 2) {
        return {
          fullStream: (async function* () {
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "tool-input-start", id: "call_protocol", toolName: LLM.PROTOCOL_OUTPUT_TOOL }
            yield {
              type: "tool-call",
              toolCallId: "call_protocol",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input: answer,
            }
            yield {
              type: "tool-result",
              toolCallId: "call_protocol",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input: answer,
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
              '<protocol-result>{"status":"completed"}</protocol-result>',
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
              const protocol = sessionAfter.dsl_context?.protocol as
                | {
                    runs?: { status: string; actions: { output?: string; tool_call_ids: string[] }[] }[]
                  }
                | undefined

              expect(result).toBe("stop")
              expect(calls).toBe(2)
              expect(parts.some((part) => part.type === "reasoning" && part.text.includes("Need files."))).toBe(true)
              expect(
                parts.some(
                  (part) => part.type === "text" && part.metadata?.kind === "protocol_malformed" && part.ignored,
                ),
              ).toBe(true)
              expect(
                parts.some((part) => part.type === "text" && part.text.includes("agent-protocol") && !part.ignored),
              ).toBe(false)
              expect(protocol?.runs).toBeUndefined()
            },
          }),
      })
    } finally {
      hook.mockRestore()
    }
  })

  test("verifier dependency parsing leaves empty depends_on for runtime execution", () => {
    // A V2 protocol with no depends reaches the runtime untouched so verifier
    // actions can run with protocol context even without a worker handoff.
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

  test("verifier dependency parsing strips the 'none' sentinel", () => {
    // The schema strips the legacy sentinel before execution. For verifier
    // items, the runtime now treats the resulting empty depends_on as allowed.
    const decl = AgentProtocol.parse({
      version: "2",
      items: [{ id: "review", kind: "agent", target: "security-reviewer", prompt: "review", depends: ["none"] }],
    })
    if (decl.payload?.type !== "action_graph") throw new Error("not action_graph")
    const review = decl.payload.actions.find((a) => a.id === "review")
    expect(review?.depends_on).toEqual([])
  })
})
