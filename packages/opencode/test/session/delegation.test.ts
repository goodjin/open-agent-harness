import { describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionDelegation } from "../../src/session/delegation"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { RuntimeTools } from "../../src/session/runtime-tools"
import { ActionResult } from "../../src/session/action-result"
import { SessionResult } from "../../src/session/result"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionTask } from "../../src/session/task"
import { SessionLog } from "../../src/session/log"
import type { AgentProtocol } from "../../src/protocol/schema"
import { and, Database, eq } from "../../src/storage/db"
import { AssignmentTable, SessionResultTable } from "../../src/session/session.sql"

describe("SessionDelegation", () => {
  const poll = async (fn: () => boolean | Promise<boolean>, timeout = 5_000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await fn()) return
      await Bun.sleep(10)
    }
    throw new Error("condition timeout")
  }

  test("cancels pending delegated children and submits an aggregate handoff", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_cancel_children",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })

              const result = await SessionDelegation.cancel({
                sessionID: parent.id,
                runID: "apr_cancel_children",
                reason: "No longer needed",
              })
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { child_session_id?: string; status?: string; summary?: string }[]
              }
              const messages = await MessageV2.filterCompacted(MessageV2.stream(child.id))

              expect(result).toBe(true)
              expect(SessionStatus.get(child.id)).toEqual({ type: "aborted", message: "No longer needed" })
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("failed")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("No child result was requested or collected")
              expect(
                messages.some(
                  (msg) =>
                    msg.info.role === "user" &&
                    msg.parts.some((part) => part.type === "text" && part.text.includes("cancel_delegated_task")),
                ),
              ).toBe(true)
              const sent = prompts.filter((entry) => entry.sessionID === parent.id)
              expect(sent).toHaveLength(1)
              expect(sent[0]?.parts?.some((part) => part.type === "text" && part.text.includes("Partial: 0"))).toBe(
                true,
              )
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("new delegated assignments require ActionResult before notifying parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "backend",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "backend",
        agent: input.agent ?? "backend",
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
        text: "reminded",
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_action_result_required",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "text",
                text: "plain result",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)

              const result = await SessionDelegation.complete({ sessionID: child.id })
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: unknown[]
              }

              expect(result).toBe(false)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(child.id)
              expect(
                prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("ActionResult")),
              ).toBe(true)
              expect(
                prompts[0]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("<agent-delegation-result>"),
                ),
              ).toBe(false)
              expect(pctx.pending_delegations?.[child.id]).toBeDefined()
              expect(pctx.completed_delegations ?? []).toHaveLength(0)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("delegated child timeline record moves from current to history after parent notification", async () => {
    await using tmp = await tmpdir()
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                parentID: user.id,
                role: "assistant",
                mode: "protocol-runner",
                agent: "protocol-runner",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await SessionDelegation.assign({
                action: {
                  type: "action",
                  id: "impl",
                  title: "Implement timeline",
                  operation: "modify",
                  executor: { type: "agent", target: "backend", capabilities: [] },
                  input: {},
                  depends_on: [],
                  context_refs: [],
                  verification: {},
                  result_policy: "summary",
                },
                agent: "backend",
                childID: child.id,
                messageID: assistant.id,
                parentAgent: "protocol-runner",
                runID: "apr_timeline_child",
                sessionID: parent.id,
              })
              const first = await MessageV2.get({ sessionID: parent.id, messageID: user.id })
              expect(first.info.role).toBe("user")
              const firstTurn = first.info.role === "user" ? first.info.metadata?.turn : undefined
              expect((firstTurn as { children?: { id?: string; current?: boolean }[] }).children).toMatchObject([
                { id: child.id, current: true },
              ])

              const childUser = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: childUser.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "success",
                    result: "Implemented timeline record.",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const last = await MessageV2.get({ sessionID: parent.id, messageID: user.id })
              expect(last.info.role).toBe("user")
              const lastTurn = last.info.role === "user" ? last.info.metadata?.turn : undefined
              const rows = (
                lastTurn as {
                  children?: {
                    id?: string
                    current?: boolean
                    status?: string
                    result_id?: string
                    summary?: string
                    fallback?: boolean
                  }[]
                }
              ).children
              expect(rows).toMatchObject([{ id: child.id, current: false, status: "completed" }])
              expect(rows?.[0]?.result_id).toBeString()
              expect(rows?.[0]?.summary).toContain("Implemented timeline record.")
              expect(rows?.[0]?.summary?.length).toBeLessThanOrEqual(4000)
              expect(rows?.[0]?.fallback).toBe(false)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("verifier ActionResult reminders include inferred target action id", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      return { info: {} as MessageV2.Assistant, parts: [] } as MessageV2.WithParts
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "release-runner-verifier" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_verifier_reminder",
                action_id: "cut_v0_4_1_release_test",
                action_title: "Test cut_v0_4_1_release",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "release-runner-verifier",
                result_policy: "summary",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "release-runner-verifier",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "release-runner-verifier",
                agent: "release-runner-verifier",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "text",
                text: "plain verifier output",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)

              expect(await SessionDelegation.complete({ sessionID: child.id })).toBe(false)
              expect(prompts).toHaveLength(1)
              const text = prompts[0]?.parts?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
              expect(text).toContain("Verifier result required fields")
              expect(text).toContain('"target_action_id": "cut_v0_4_1_release"')
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("planner AgentProtocolOutput completes delegated child handoff", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "feature-planner" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_protocol_terminal",
                action_id: "plan",
                action_title: "Plan feature",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "feature-planner",
                result_policy: "structured",
                result_tool: "AgentProtocolOutput",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "feature-planner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "feature-planner",
                agent: "feature-planner",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_plan",
                tool: "AgentProtocolOutput",
                state: {
                  status: "completed",
                  input: {
                    version: "2",
                    items: [
                      {
                        id: "done",
                        kind: "success",
                        summary: "Renderer layer delivered",
                        message: "F2 renderers completed.",
                        changed_files: ["packages/renderers.ts"],
                      },
                    ],
                  },
                  output: "Protocol result received.",
                  title: "Agent Protocol Output",
                  metadata: { agent_protocol_output: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: {
                  child_session_id?: string
                  result_id?: string
                  protocol_result?: unknown
                }[]
              }
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.protocol_result).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.result_id).toBeString()
              const rec = await SessionResult.get(pctx.completed_delegations?.[0]?.result_id ?? "")
              const raw = (await SessionResult.raw(rec?.id ?? "")) as {
                carrier?: string
                item_index?: number
                item?: { kind?: string; message?: string }
                items?: unknown[]
              }
              expect(rec?.carrier).toBe("agent_protocol_output")
              expect(raw.item_index).toBe(0)
              expect(raw.item?.kind).toBe("success")
              expect(raw.item?.message).toBe("F2 renderers completed.")
              expect(raw.items).toBeUndefined()
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("planner AgentProtocolOutput plain text completes delegated child handoff", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "feature-planner" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_protocol_plain",
                action_id: "plan",
                action_title: "Plan feature",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "feature-planner",
                result_policy: "structured",
                result_tool: "AgentProtocolOutput",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    pending_delegations: { [child.id]: item },
                    runs: [
                      {
                        runID: "apr_protocol_plain",
                        title: "Protocol plain",
                        status: "blocked",
                        total: 1,
                        completed: 0,
                        actions: [
                          {
                            id: "plan",
                            title: "Plan feature",
                            operation: "feature-planner",
                            executor: { type: "agent", target: "feature-planner", capabilities: [] },
                            status: "blocked",
                            summary: "Delegated to feature-planner.",
                          },
                        ],
                      },
                    ],
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "feature-planner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "feature-planner",
                agent: "feature-planner",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "text",
                text: "Plan is complete in plain text.",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: { child_session_id?: string; result_id?: string; status?: string }[]
                runs?: { status?: string; completed?: number; actions?: { status?: string; summary?: string }[] }[]
              }
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("completed")
              expect(pctx.runs?.[0]?.status).toBe("completed")
              expect(pctx.runs?.[0]?.completed).toBe(1)
              expect(pctx.runs?.[0]?.actions?.[0]?.status).toBe("completed")
              expect(pctx.runs?.[0]?.actions?.[0]?.summary).toContain("Plan is complete in plain text")
              const rec = await SessionResult.get(pctx.completed_delegations?.[0]?.result_id ?? "")
              expect(rec?.carrier).toBe("plain_text_result")
              expect(rec?.satisfying).toBe(true)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("blocked protocol plain text result does not start dependent sibling", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "feature-planner" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_protocol_plain_blocked",
                action_id: "plan",
                action_title: "Plan feature",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "feature-planner",
                result_policy: "structured",
                result_tool: "AgentProtocolOutput",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_protocol_plain_blocked",
                    runs: [
                      {
                        runID: "apr_protocol_plain_blocked",
                        title: "Protocol plain blocked",
                        status: "running",
                        actions: [
                          {
                            id: "plan",
                            title: "Plan feature",
                            operation: "plan",
                            executor: { type: "agent", target: "feature-planner", capabilities: [] },
                            depends_on: [],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "review",
                            title: "Review plan",
                            operation: "review",
                            executor: { type: "agent", target: "verifier", capabilities: [] },
                            depends_on: ["plan"],
                            result_policy: "summary",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                        ],
                      },
                    ],
                    pending_delegations: { [child.id]: item },
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "feature-planner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "feature-planner",
                agent: "feature-planner",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "text",
                text: "Protocol blocked: plan needs parent decision.",
                metadata: {
                  kind: "protocol_summary",
                  protocol: {
                    runID: "apr_protocol_plain_blocked",
                    status: "blocked",
                    title: "Protocol plain blocked",
                  },
                },
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, { action_id?: string }>
                completed_delegations?: { child_session_id?: string; result_id?: string; status?: string }[]
              }
              expect(Object.values(pctx.pending_delegations ?? {}).some((row) => row.action_id === "review")).toBe(
                false,
              )
              expect(pctx.completed_delegations?.[0]?.status).toBe("blocked")
              const rec = await SessionResult.get(pctx.completed_delegations?.[0]?.result_id ?? "")
              expect(rec?.carrier).toBe("plain_text_result")
              expect(rec?.satisfying).toBe(false)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("ActionResult assignment accepts AgentProtocolOutput reply handoff", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_cross_reply",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_reply",
                tool: "AgentProtocolOutput",
                state: {
                  status: "completed",
                  input: {
                    version: "2",
                    items: [
                      {
                        id: "blocked",
                        kind: "reply",
                        message: "Need parent decision before continuing.",
                      },
                    ],
                  },
                  output: "Protocol result received.",
                  title: "Agent Protocol Output",
                  metadata: { agent_protocol_output: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: {
                  child_session_id?: string
                  result_id?: string
                  protocol_result?: unknown
                  status?: string
                }[]
              }
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("terminal_reply")
              expect(pctx.completed_delegations?.[0]?.protocol_result).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.result_id).toBeString()
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("satisfied child result starts dependent agent action without parent fan-in", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const tasks: Awaited<ReturnType<typeof SessionTask.get>>[] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      tasks.push(await SessionTask.get(input.sessionID))
      prompts.push(input)
      return await new Promise<MessageV2.WithParts>(() => {})
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_dep_resume",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_dep_resume",
                    runs: [
                      {
                        runID: "apr_dep_resume",
                        title: "Resume depends",
                        status: "running",
                        actions: [
                          {
                            id: "impl",
                            title: "Implement",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            depends_on: [],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "review",
                            title: "Review",
                            description: "Review implementation",
                            operation: "backend",
                            executor: { type: "agent", target: "general-executor", capabilities: [] },
                            depends_on: ["impl"],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                        ],
                      },
                    ],
                    pending_delegations: { [child.id]: item },
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "success",
                    result: "implemented",
                    changed_files: "",
                    verification: "done",
                    blockers: "",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              await poll(() => prompts.length > 0)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, { action_id?: string; child_session_id?: string }>
              }
              const rows = Object.values(pctx.pending_delegations ?? {})
              const review = rows.find((row) => row.action_id === "review")
              expect(rows.some((row) => row.action_id === "review")).toBe(true)
              expect(rows.some((row) => row.action_id === "impl")).toBe(false)
              expect(review?.child_session_id).toBeTruthy()
              const active = review?.child_session_id
                ? await SessionAssignment.active(SessionID.make(review.child_session_id))
                : undefined
              expect(active?.source_type).toBe("delegation")
              expect(active?.source_action_id).toBe("review")
              expect(tasks[0]?.task).toMatchObject({
                source_type: "delegation",
                source_ref: {
                  sessionID: parent.id,
                  runID: "apr_dep_resume",
                  actionID: "review",
                },
              })
              expect(tasks[0]?.revision).toMatchObject({ title: "Review", body: "Review" })
              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(false)
              expect(
                review?.child_session_id ? await SessionTask.history(SessionID.make(review.child_session_id)) : [],
              ).toHaveLength(0)
              expect(SessionStatus.get(parent.id).type).toBe("waiting_child")
              expect(prompts.some((entry) => entry.sessionID === parent.id)).toBe(false)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("compensates same-run dependent child when assignment binding fails", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      return await new Promise<MessageV2.WithParts>(() => {})
    }) as never)
    const delegate = SessionAssignment.delegate
    const bind = spyOn(SessionAssignment, "delegate").mockImplementation(async (input) => {
      const saved = await delegate(input)
      throw new Error(`SQLITE_BUSY:${saved.id}`)
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const owner = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                role: "user",
                time: { created: Date.now() },
                agent: "protocol-runner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                parentID: owner.id,
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
              const messageID = assistant.id
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_dep_bind_fail",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: messageID,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_dep_bind_fail",
                    runs: [
                      {
                        runID: "apr_dep_bind_fail",
                        title: "Resume bind failure",
                        status: "running",
                        actions: [
                          {
                            id: "impl",
                            title: "Implement",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            depends_on: [],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "review",
                            title: "Review",
                            operation: "backend",
                            executor: { type: "agent", target: "general-executor", capabilities: [] },
                            depends_on: ["impl"],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                        ],
                      },
                    ],
                    pending_delegations: { [child.id]: item },
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl_fail",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "success",
                    result: "implemented",
                    changed_files: "",
                    verification: "done",
                    blockers: "",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const failed = await SessionAssignment.bySource({
                sessionID: parent.id,
                runID: "apr_dep_bind_fail",
                actionID: "review",
              })
              if (!failed) throw new Error("failed assignment missing")
              const ctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, { action_id?: string }>
              }
              expect(failed.status).toBe("failed")
              expect(Object.values(ctx.pending_delegations ?? {}).some((entry) => entry.action_id === "review")).toBe(
                false,
              )
              expect(await SessionAssignment.active(failed.session_id)).toBeUndefined()
              expect(await SessionTask.get(failed.session_id)).toBeUndefined()
              expect(["failed", "error", "aborted"]).toContain(SessionStatus.get(failed.session_id).type)
              expect(prompts.some((entry) => entry.sessionID === failed.session_id)).toBe(false)
              const info = await Session.get(failed.session_id)
              const audit = (
                info.dsl_context?.protocol as {
                  failed_delegation?: { action_id?: string; action_title?: string; agent?: string }
                }
              )?.failed_delegation
              const first = await MessageV2.get({ sessionID: parent.id, messageID: owner.id })
              const rows = first.info.role === "user" ? first.info.metadata?.turn?.children : undefined
              const row = rows?.find((entry: { id?: string }) => entry.id === failed.session_id)
              expect(row).toMatchObject({
                id: failed.session_id,
                label: audit?.action_title,
                action: audit?.action_id,
                agent: audit?.agent,
                current: false,
                status: "failed",
                completed_at: expect.any(Number),
              })
              const time = row?.completed_at
              await SessionDelegation.fail({
                action: {
                  type: "action",
                  id: "tampered_action",
                  title: "Tampered title",
                  operation: "backend",
                  executor: { type: "agent", target: "tampered-agent", capabilities: [] },
                  input: {},
                  depends_on: [],
                  context_refs: [],
                  result_policy: "summary",
                },
                agent: "tampered-agent",
                binding: true,
                childID: failed.session_id,
                error: new Error("repeat"),
                messageID,
                parentAgent: "tampered-parent",
                parentID: parent.id,
                runID: "tampered-run",
              })
              const repeated = await MessageV2.get({ sessionID: parent.id, messageID: owner.id })
              const next = repeated.info.role === "user" ? repeated.info.metadata?.turn?.children : undefined
              expect(next?.filter((entry: { id?: string }) => entry.id === failed.session_id)).toHaveLength(1)
              expect(next?.find((entry: { id?: string }) => entry.id === failed.session_id)).toMatchObject({
                id: failed.session_id,
                label: audit?.action_title,
                action: audit?.action_id,
                agent: audit?.agent,
                current: false,
                status: "failed",
                completed_at: time,
              })
              const pending = (
                (await Session.get(parent.id)).dsl_context?.protocol as {
                  pending_delegations?: object
                }
              ).pending_delegations
              expect(Object.keys(pending ?? {})).toHaveLength(0)
              expect(SessionStatus.get(failed.session_id).type).toBe("failed")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
      bind.mockRestore()
    }
  })

  test("ActionResult assignment AgentProtocolOutput answer starts dependent agent action", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      return await new Promise<MessageV2.WithParts>(() => {})
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_cross_answer_dep",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_cross_answer_dep",
                    runs: [
                      {
                        runID: "apr_cross_answer_dep",
                        title: "Resume depends",
                        status: "running",
                        actions: [
                          {
                            id: "impl",
                            title: "Implement",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            depends_on: [],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "review",
                            title: "Review",
                            operation: "backend",
                            executor: { type: "agent", target: "general-executor", capabilities: [] },
                            depends_on: ["impl"],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                        ],
                      },
                    ],
                    pending_delegations: { [child.id]: item },
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_answer",
                tool: "AgentProtocolOutput",
                state: {
                  status: "completed",
                  input: {
                    version: "2",
                    items: [
                      {
                        id: "impl",
                        kind: "answer",
                        message: "Implementation finished.",
                      },
                    ],
                  },
                  output: "Protocol result received.",
                  title: "Agent Protocol Output",
                  metadata: { agent_protocol_output: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, { action_id?: string }>
              }
              const rows = Object.values(pctx.pending_delegations ?? {})
              expect(rows.some((row) => row.action_id === "review")).toBe(true)
              expect(rows.some((row) => row.action_id === "impl")).toBe(false)
              expect(SessionStatus.get(parent.id).type).toBe("waiting_child")
              expect(prompts.some((entry) => entry.sessionID === parent.id)).toBe(false)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("non-satisfying child result does not start dependent agent action", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_dep_failure",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_dep_failure",
                    runs: [
                      {
                        runID: "apr_dep_failure",
                        title: "Failure does not resume",
                        status: "running",
                        actions: [
                          {
                            id: "impl",
                            title: "Implement",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            depends_on: [],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "review",
                            title: "Review",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            depends_on: ["impl"],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                        ],
                      },
                    ],
                    pending_delegations: { [child.id]: item },
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "failure",
                    result: "failed",
                    changed_files: "",
                    verification: "",
                    blockers: "blocked",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, { action_id?: string }>
              }
              expect(Object.values(pctx.pending_delegations ?? {}).some((row) => row.action_id === "review")).toBe(
                false,
              )
              const sent = prompts.filter((entry) => entry.sessionID === parent.id)
              expect(sent).toHaveLength(1)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("delegated planner waits for nested child sessions before notifying parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "feature-planner",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "feature-planner",
        agent: input.agent ?? "feature-planner",
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
    const result = async (sessionID: SessionID, result: string) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "feature-planner",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        parentID: user.id,
        role: "assistant",
        mode: "feature-planner",
        agent: "feature-planner",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "tool",
        callID: "call_plan_feature",
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "worker",
            action_id: "plan_feature",
            status: "success",
            result,
            changed_files: "",
            verification: "Nested child sessions handled the executable work.",
            blockers: "",
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      return msg
    }

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const planner = await Session.create({ parentID: parent.id, agent: "feature-planner" })
              const worker = await Session.create({ parentID: planner.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_nested_plan",
                action_id: "plan_feature",
                action_title: "Plan Feature",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: planner.id,
                agent: "feature-planner",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              const child = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_nested_worker",
                action_id: "impl_feature",
                action_title: "Implement Feature",
                parent_session_id: planner.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "feature-planner",
                child_session_id: worker.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [planner.id]: item } } },
              })
              await Session.setDslContext({
                sessionID: planner.id,
                dsl_context: {
                  protocol: {
                    delegation: item,
                    pending_delegations: { [worker.id]: child },
                    verification_cycles: { impl_feature: 1 },
                  },
                },
              })

              const first = await result(planner.id, "Nested work has been dispatched.")
              expect(await SessionDelegation.complete({ sessionID: planner.id, messageID: first.id })).toBe(false)
              let ctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: unknown[]
              }
              expect(ctx.pending_delegations?.[planner.id]).toBeDefined()
              expect(ctx.completed_delegations ?? []).toHaveLength(0)
              expect(prompts).toHaveLength(0)

              await Session.setDslContext({
                sessionID: planner.id,
                dsl_context: {
                  protocol: {
                    delegation: item,
                    pending_delegations: {},
                    completed_delegations: [{ ...child, status: "completed", summary: "worker done" }],
                    verification_cycles: {},
                  },
                },
              })
              const final = await result(planner.id, "Nested feature work is complete.")
              expect(await SessionDelegation.complete({ sessionID: planner.id, messageID: final.id })).toBe(true)
              ctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: unknown[]
              }
              expect(ctx.pending_delegations?.[planner.id]).toBeUndefined()
              expect(ctx.completed_delegations).toHaveLength(1)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
              expect(
                prompts[0]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("Nested feature work is complete"),
                ),
              ).toBe(true)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("notifies parent only after delegated children from every active run end", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
    const done = async (sessionID: SessionID, action: string, result: string) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "backend",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        parentID: user.id,
        role: "assistant",
        mode: "backend",
        agent: "backend",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "tool",
        callID: `call_${action}`,
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "worker",
            action_id: action,
            status: "success",
            result,
            changed_files: "",
            verification: "done",
            blockers: "",
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      return msg
    }

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const one = await Session.create({ parentID: parent.id, agent: "backend" })
              const two = await Session.create({ parentID: parent.id, agent: "backend" })
              const base = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_sibling_wait",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              const first = {
                ...base,
                action_id: "one",
                action_title: "First child",
                child_session_id: one.id,
              }
              const second = {
                ...base,
                run_id: "apr_sibling_wait_next",
                action_id: "two",
                action_title: "Second child",
                child_session_id: two.id,
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    pending_delegations: { [one.id]: first, [two.id]: second },
                    confirmations: [
                      {
                        run_id: "apr_old_confirm",
                        action_id: "confirm_old",
                        action_title: "Old confirmation",
                        message_id: MessageID.ascending(),
                        plan: "Dispatch the old plan",
                        status: "pending",
                        updated_at: Date.now() - 1,
                      },
                    ],
                  },
                },
              })
              await Session.setDslContext({ sessionID: one.id, dsl_context: { protocol: { delegation: first } } })
              await Session.setDslContext({ sessionID: two.id, dsl_context: { protocol: { delegation: second } } })

              await done(one.id, "one", "first done")
              expect(await SessionDelegation.complete({ sessionID: one.id })).toBe(false)
              expect(prompts).toHaveLength(0)
              expect(SessionStatus.get(parent.id).type).toBe("waiting_child")

              await done(two.id, "two", "second done")
              expect(await SessionDelegation.complete({ sessionID: two.id })).toBe(true)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
              expect(
                prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("## Child Results")),
              ).toBe(true)
              expect(
                prompts[0]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("<agent-delegation-result>"),
                ),
              ).toBe(false)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("first done"))).toBe(
                true,
              )
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("second done"))).toBe(
                true,
              )
              expect(
                prompts[0]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("previous confirmation request became stale"),
                ),
              ).toBe(true)
              const vals = (await Session.get(parent.id)).dsl_context?.protocol as {
                confirmations?: { refresh_status?: string; status?: string }[]
              }
              expect(vals.confirmations?.[0]).toMatchObject({ status: "superseded", refresh_status: "delivered" })
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("queues a completed child result without overriding waiting_user", async () => {
    await using tmp = await tmpdir()
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      _input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      throw new Error("waiting_user parent must not start a prompt loop")
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "run_waiting_user",
                action_id: "inspect",
                action_title: "Inspect child",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: assistant.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_inspect",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "inspect",
                    status: "success",
                    result: "Inspection completed.",
                    changed_files: "",
                    verification: "done",
                    blockers: "",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)
              SessionStatus.set(parent.id, { type: "waiting_user" })

              expect(await SessionDelegation.complete({ sessionID: child.id })).toBe(true)
              expect(SessionStatus.get(parent.id)).toEqual({ type: "waiting_user" })
              expect(prompt).not.toHaveBeenCalled()

              const messages = await Session.messages({ sessionID: parent.id })
              const queued = messages.flatMap((msg) =>
                msg.info.role === "user" &&
                msg.info.metadata?.source === "delegation" &&
                msg.info.metadata.turn?.status === "queued"
                  ? [msg.info]
                  : [],
              )
              const logs = await SessionLog.list({ sessionID: parent.id, limit: 100 })
              expect(queued).toHaveLength(1)
              expect(queued[0]?.metadata?.run_id).toBe("run_waiting_user")
              expect(logs.some((log) => log.type === "protocol.delegation.queued")).toBe(true)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("manual submit aggregates current child results and statuses", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
      return { info: msg, parts: [] } as MessageV2.WithParts
    }) as never)
    const done = async (sessionID: SessionID, action: string, result: string) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "backend",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        parentID: user.id,
        role: "assistant",
        mode: "backend",
        agent: "backend",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "tool",
        callID: `call_${action}`,
        tool: "ActionResult",
        state: {
          status: "completed",
          input: {
            kind: "action_result",
            role: "worker",
            action_id: action,
            status: "success",
            result,
            changed_files: "",
            verification: "done",
            blockers: "",
          },
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
      return msg
    }

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const one = await Session.create({ parentID: parent.id, agent: "backend" })
              const two = await Session.create({ parentID: parent.id, agent: "backend" })
              const base = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "manual_submit",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              const first = {
                ...base,
                action_id: "done",
                action_title: "Done child",
                child_session_id: one.id,
              }
              const second = {
                ...base,
                action_id: "stopped",
                action_title: "Stopped child",
                child_session_id: two.id,
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [one.id]: first, [two.id]: second } } },
              })
              await Session.setDslContext({ sessionID: one.id, dsl_context: { protocol: { delegation: first } } })
              await Session.setDslContext({ sessionID: two.id, dsl_context: { protocol: { delegation: second } } })

              await done(one.id, "done", "child done")
              expect(await SessionDelegation.complete({ sessionID: one.id })).toBe(false)
              SessionStatus.set(two.id, { type: "interrupted", message: "Process stopped." })

              expect(
                await SessionDelegation.submit({ sessionID: parent.id, runID: "manual_submit", force: true }),
              ).toBe(true)
              expect(prompts).toHaveLength(2)
              expect(prompts[0]?.agent).toBe("summary")
              expect(
                prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("Child Transcript")),
              ).toBe(true)
              expect(prompts[1]?.sessionID).toBe(parent.id)
              expect(prompts[1]?.parts?.some((part) => part.type === "text" && part.text.includes("child done"))).toBe(
                true,
              )
              expect(
                prompts[1]?.parts?.some((part) => part.type === "text" && part.text.includes("- Status: partial")),
              ).toBe(true)
              const ctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: { child_session_id?: string }[]
              }
              expect(Object.keys(ctx.pending_delegations ?? {})).toHaveLength(0)
              expect(ctx.completed_delegations).toHaveLength(2)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("terminate-with-result submit stops pending child and summarizes transcript", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
        text:
          input.agent === "summary"
            ? "Task result: current implementation is halfway done. Verification: not run. Remaining risk: child was terminated."
            : "parent resumed",
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "manual_terminate",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: user.id,
                sessionID: child.id,
                type: "text",
                text: "Implement the renderer.",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)
              await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now() },
                finish: "unknown",
              } as MessageV2.Assistant)
              SessionStatus.set(child.id, { type: "running" })

              expect(
                await SessionDelegation.submit({
                  sessionID: parent.id,
                  runID: "manual_terminate",
                  mode: "terminate_with_result",
                }),
              ).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: { child_session_id?: string; status?: string; summary?: string }[]
              }
              const summary = prompts.find((item) => item.agent === "summary")

              expect(SessionStatus.get(child.id)).toEqual({
                type: "user_completed",
                message: "Terminated by user after collecting current result.",
              })
              expect(
                summary?.parts?.some((part) => part.type === "text" && part.text.includes("Child Transcript")),
              ).toBe(true)
              expect(Object.keys(pctx.pending_delegations ?? {})).toHaveLength(0)
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("partial")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("current implementation is halfway done")
              expect(prompts.some((item) => item.sessionID === parent.id)).toBe(true)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("terminate-with-result reuses completed child native result without changing status", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "manual_completed_reuse",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const msg = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "success",
                    result: "renderer done",
                    changed_files: "",
                    verification: "done",
                    blockers: "",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)
              SessionStatus.set(child.id, { type: "completed" })

              expect(
                await SessionDelegation.submit({
                  sessionID: parent.id,
                  runID: "manual_completed_reuse",
                  mode: "terminate_with_result",
                }),
              ).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: { child_session_id?: string; status?: string; summary?: string }[]
              }

              expect(SessionStatus.get(child.id)).toEqual({ type: "completed" })
              expect(prompts.some((item) => item.agent === "summary")).toBe(false)
              expect(Object.keys(pctx.pending_delegations ?? {})).toHaveLength(0)
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("completed")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("renderer done")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("terminate-with-result summarizes completed child only when result is missing", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
        text:
          input.agent === "summary"
            ? "Task result: completed from transcript. Verification: not structured. Remaining risk: no ActionResult."
            : "parent resumed",
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "manual_completed_summary",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const msg = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: child.id,
                type: "text",
                text: "plain final answer without native result",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)
              SessionStatus.set(child.id, { type: "completed" })

              expect(
                await SessionDelegation.submit({
                  sessionID: parent.id,
                  runID: "manual_completed_summary",
                  mode: "terminate_with_result",
                }),
              ).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: { child_session_id?: string; status?: string; summary?: string }[]
              }

              expect(SessionStatus.get(child.id)).toEqual({ type: "completed" })
              expect(prompts.filter((item) => item.agent === "summary")).toHaveLength(1)
              expect(Object.keys(pctx.pending_delegations ?? {})).toHaveLength(0)
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("partial")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("completed from transcript")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("terminate-with-result preserves terminal child status and fallback identity", async () => {
    await using tmp = await tmpdir()
    let summaries = 0
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      if (input.agent === "summary") summaries++
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "summary",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "summary",
        agent: input.agent ?? "summary",
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
        text: "terminal fallback",
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
              const states = [
                { type: "failed", message: "native failure" },
                { type: "aborted", message: "native abort" },
                { type: "terminal_reply", message: "native reply" },
                { type: "completed" },
                { type: "archived" },
              ] as const
              for (const [index, state] of states.entries()) {
                const parent = await Session.create({ agent: "default" })
                const child = await Session.create({ parentID: parent.id, agent: "backend" })
                const action = {
                  type: "action",
                  id: `terminal_${index}`,
                  title: `Terminal ${index}`,
                  operation: "delegate",
                  executor: { type: "agent", target: "backend", capabilities: [] },
                  input: {},
                  depends_on: [],
                  context_refs: [],
                  result_policy: "summary",
                } as AgentProtocol.Action
                await SessionDelegation.assign({
                  action,
                  agent: "backend",
                  childID: child.id,
                  messageID: MessageID.ascending(),
                  parentAgent: "default",
                  runID: `run_terminal_${index}`,
                  sessionID: parent.id,
                })
                if (state.type !== "archived") SessionStatus.set(child.id, { type: "running" })
                SessionStatus.set(child.id, state)

                await SessionDelegation.stop({
                  childIDs: [child.id],
                  runID: `run_terminal_${index}`,
                  sessionID: parent.id,
                })
                const first = await SessionResult.listForParent(parent.id)
                const count = summaries
                await SessionDelegation.stop({
                  childIDs: [child.id],
                  runID: `run_terminal_${index}`,
                  sessionID: parent.id,
                })

                expect(SessionStatus.get(child.id)).toEqual(state)
                expect((await SessionResult.listForParent(parent.id)).map((item) => item.id)).toEqual(
                  first.map((item) => item.id),
                )
                expect(summaries).toBe(count)
              }
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("direct terminate-with-result preserves its canonical reason in child status", async () => {
    await using tmp = await tmpdir()
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "default" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const now = Date.now()
              Database.use((db) =>
                db
                  .insert(AssignmentTable)
                  .values({
                    id: "assignment_revision_stop_reason",
                    parent_id: null,
                    session_id: child.id,
                    source_type: "delegation",
                    source_session_id: parent.id,
                    source_message_id: MessageID.ascending(),
                    source_run_id: "run_revision_stop_reason",
                    source_action_id: "revision_stop_reason",
                    target: "backend",
                    title: "Revision stop",
                    status: "running",
                    content_ref: "test",
                    content_hash: "test",
                    content_version: 1,
                    result_ref: null,
                    result_status: null,
                    time_created: now,
                    time_updated: now,
                  })
                  .run(),
              )
              SessionStatus.set(child.id, { type: "running" })

              const stopped = await SessionDelegation.stopScoped({
                childIDs: [child.id],
                runID: "run_revision_stop_reason",
                sessionID: parent.id,
                reason: "Stopped for confirmed task revision.",
              })
              expect(stopped.stopped).toEqual([child.id])
              expect(
                (
                  await SessionDelegation.stopScoped({
                    childIDs: [child.id],
                    runID: "run_revision_stop_reason",
                    sessionID: parent.id,
                    reason: "Stopped for confirmed task revision.",
                  })
                ).stopped,
              ).toEqual([])

              expect(SessionStatus.get(child.id)).toEqual({
                type: "user_completed",
                message: "Stopped for confirmed task revision.",
              })
              await poll(async () =>
                (await SessionLog.list({ sessionID: child.id, limit: 20 })).some(
                  (item) =>
                    item.type === "session.status.changed" &&
                    item.data.reason === "Stopped for confirmed task revision.",
                ),
              )
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("worker ActionResult runs verifier gates serially before notifying parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
        text: "continued",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: msg, parts: [part] } as MessageV2.WithParts
    }) as never)

    const done = async (sessionID: SessionID, agent: string, input: Record<string, unknown>) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent,
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        parentID: user.id,
        role: "assistant",
        mode: agent,
        agent,
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "tool",
        callID: `call_${input.action_id}`,
        tool: "ActionResult",
        state: {
          status: "completed",
          input,
          output: "Action result received.",
          title: "Action Result",
          metadata: { action_result: true },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)
    }
    const plain = async (sessionID: SessionID, agent: string) => {
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent,
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        parentID: user.id,
        role: "assistant",
        mode: agent,
        agent,
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: "plain follow-up after ActionResult",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return msg
    }

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const worker = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const base = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_verify_serial",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: worker.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_verify_serial",
                    runs: [
                      {
                        runID: "apr_verify_serial",
                        title: "Verify serial",
                        status: "running",
                        actions: [
                          {
                            id: "impl",
                            title: "Implement",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            depends_on: [],
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "impl_test",
                            title: "Test Implement",
                            operation: "verification_test",
                            executor: {
                              type: "agent",
                              target: "backend-verifier",
                              capabilities: ["verification", "test"],
                            },
                            depends_on: ["impl"],
                            verification: { role: "test", worker: "impl", required: true },
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                          {
                            id: "impl_review",
                            title: "Review Implement",
                            operation: "verification_review",
                            executor: {
                              type: "agent",
                              target: "backend-verifier",
                              capabilities: ["verification", "review"],
                            },
                            depends_on: ["impl", "impl_test"],
                            result_policy: "structured",
                            status: "pending",
                            summary: "",
                            tool_call_ids: [],
                            duration_ms: 0,
                            time: { started: Date.now() },
                          },
                        ],
                      },
                    ],
                    pending_delegations: { [worker.id]: base },
                  },
                },
              })
              await Session.setDslContext({ sessionID: worker.id, dsl_context: { protocol: { delegation: base } } })
              await done(worker.id, "backend", {
                kind: "action_result",
                role: "worker",
                action_id: "impl",
                status: "success",
                scope: "task",
                result: "Implemented task",
                changed_files: "packages/api.ts",
                verification: "bun test",
                blockers: "none",
              })
              const final = await plain(worker.id, "backend")

              expect(await SessionDelegation.complete({ sessionID: worker.id, messageID: final.id })).toBe(true)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.agent).toBe("backend-verifier")
              expect(prompts[0]?.sessionID).not.toBe(parent.id)
              expect(prompts[0]?.sessionID).not.toBe(worker.id)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("impl_test"))).toBe(
                true,
              )
              const testSession = prompts[0]!.sessionID
              const test = (await Session.get(testSession)).dsl_context?.protocol as {
                delegation?: { action_id?: string }
              }
              expect((await Session.get(testSession)).parentID).toBe(worker.id)
              expect(test.delegation?.action_id).toBe("impl_test")

              await done(testSession, "backend-verifier", {
                kind: "action_result",
                role: "verifier",
                action_id: "impl_test",
                target_action_id: "impl",
                status: "success",
                result: "Tests pass",
                issues: "none",
                evidence: "bun test",
                worker_feedback: "Accepted",
              })
              expect(await SessionDelegation.complete({ sessionID: testSession })).toBe(true)
              expect(prompts).toHaveLength(2)
              expect(prompts[1]?.agent).toBe("backend-verifier")
              expect(prompts[1]?.sessionID).not.toBe(testSession)
              expect(prompts[1]?.parts?.some((part) => part.type === "text" && part.text.includes("impl_review"))).toBe(
                true,
              )
              const reviewSession = prompts[1]!.sessionID
              expect((await Session.get(reviewSession)).parentID).toBe(worker.id)

              await done(reviewSession, "backend-verifier", {
                kind: "action_result",
                role: "verifier",
                action_id: "impl_review",
                target_action_id: "impl",
                status: "success",
                result: "Review pass",
                issues: "none",
                evidence: "reviewed diff",
                worker_feedback: "Accepted",
              })
              const notified = await SessionDelegation.complete({ sessionID: reviewSession })
              expect(notified || prompts.length === 3).toBe(true)
              expect(prompts).toHaveLength(3)
              expect(prompts[2]?.sessionID).toBe(parent.id)
              expect(
                prompts[2]?.parts?.some(
                  (part) => part.type === "text" && part.text.includes("<agent-delegation-result>"),
                ),
              ).toBe(false)
              expect(
                prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("## Child Results")),
              ).toBe(true)
              expect(prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("Tests pass"))).toBe(
                true,
              )
              expect(prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("Review pass"))).toBe(
                true,
              )
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
              }
              expect(Object.keys(pctx.pending_delegations ?? {})).toHaveLength(0)
              const wctx = (await Session.get(worker.id)).dsl_context as {
                result?: { action_id?: string; status?: string; result_id?: string; action_result?: unknown }
              }
              expect(wctx.result?.action_id).toBe("impl")
              expect(wctx.result?.status).toBe("completed")
              expect(wctx.result?.action_result).toBeUndefined()
              expect(wctx.result?.result_id).toBeString()
              const rec = await SessionResult.get(wctx.result?.result_id ?? "")
              const raw = (await SessionResult.raw(rec?.id ?? "")) as {
                carrier?: string
                input?: { role?: string; result?: string }
              }
              expect(rec?.carrier).toBe("action_result")
              expect(raw.input?.role).toBe("worker")

              const planner = await Agent.get("feature-planner")
              if (!planner) throw new Error("expected feature-planner")
              const runtime = await RuntimeTools.build({
                agent: planner,
                model: {
                  id: ModelID.make("gpt-5.2"),
                  providerID: ProviderID.make("openai"),
                  api: { id: "openai", npm: "" },
                } as never,
                session: parent,
                tools: {},
                processor: {
                  get message() {
                    return { id: msg } as never
                  },
                  partFromToolCall() {
                    return undefined
                  },
                } as never,
                bypassAgentCheck: false,
                messages: [],
              })
              const out = (await runtime.execute(
                "session_result",
                {
                  child_session_id: worker.id,
                  include_output: true,
                },
                {
                  toolCallId: "call_result",
                  abortSignal: new AbortController().signal,
                } as never,
              )) as { output: string }
              const parsed = JSON.parse(out.output) as {
                result?: { action_id?: string; action_result?: { role?: string }; output?: string }
              }
              expect(parsed.result?.action_id).toBe("impl")
              expect(parsed.result?.action_result?.role).toBe("worker")
              expect(parsed.result?.output).toContain("Review pass")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("worker ActionResult self-target verifier shape still completes worker action", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_self_target_worker",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "summary",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    current: "apr_self_target_worker",
                    pending_delegations: { [child.id]: item },
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "verifier",
                    action_id: "impl",
                    target_action_id: "impl",
                    status: "success",
                    result: "Implemented task",
                    issues: "",
                    evidence: "",
                    worker_feedback: "",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: {
                  action_result?: unknown
                  action_id?: string
                  result_id?: string
                  summary?: string
                }[]
                pending_delegations?: Record<string, unknown>
              }
              const cctx = (await Session.get(child.id)).dsl_context as {
                result?: { action_result?: unknown; action_id?: string; result_id?: string; summary?: string }
              }
              expect(Object.keys(pctx.pending_delegations ?? {})).toHaveLength(0)
              expect(pctx.completed_delegations?.[0]?.action_id).toBe("impl")
              expect(pctx.completed_delegations?.[0]?.action_result).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.result_id).toBeString()
              const parsed = await SessionResult.parse(pctx.completed_delegations?.[0]?.result_id ?? "")
              expect(parsed?.action_result?.role).toBe("worker")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("Implemented task")
              expect(cctx.result?.action_result).toBeUndefined()
              expect(cctx.result?.result_id).toBe(pctx.completed_delegations?.[0]?.result_id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("ActionResult requires an explicit result field", () => {
    expect(
      ActionResult.parse({
        action_id: "survey",
        status: "success",
        summary: "Survey completed",
        changed_files: "none",
        verification: "read-only",
        blockers: "none",
      }).success,
    ).toBe(false)
  })

  test("user confirmed fallback stores edited child output and notifies parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      return { info: {} as never, parts: [] }
    }) as never)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_fallback",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              SessionStatus.set(child.id, { type: "blocked", message: "Stopped after failed ActionResult calls." })

              const ok = await SessionDelegation.confirmFallback({
                sessionID: child.id,
                status: "success",
                result: "Edited fallback result.",
                originalMessageID: MessageID.make("msg_original"),
                edited: true,
              })
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: {
                  child_session_id?: string
                  result_id?: string
                  status?: string
                  summary?: string
                  metadata?: unknown
                }[]
              }

              expect(ok).toBe(true)
              expect(SessionStatus.get(child.id).type).toBe("user_completed")
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("completed")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("User-confirmed fallback result")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("Edited fallback result.")
              const raw = await SessionResult.raw(pctx.completed_delegations?.[0]?.result_id ?? "")
              expect(JSON.stringify(raw)).toContain("user_confirmed_fallback")
              expect(prompts[0]?.sessionID).toBe(parent.id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("ActionResult failure creates automatic fallback summary before notifying parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "summary",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const msg = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "summary",
        agent: input.agent ?? "summary",
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
        text:
          input.agent === "summary"
            ? "Task result: created docs/audit.md. Verification: wc -l passed. Remaining risk: review pending."
            : "parent resumed",
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
              const parent = await Session.create({ agent: "feature-planner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const owner = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                role: "user",
                time: { created: Date.now() },
                agent: "feature-planner",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_fallback_summary",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: owner.id,
                parent_agent: "feature-planner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: user.id,
                sessionID: child.id,
                type: "text",
                text: "Please create docs/audit.md and verify its line count.",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)
              const msg = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: child.id,
                type: "text",
                text: "Created docs/audit.md and verified it with wc -l.",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: child.id,
                type: "tool",
                tool: "ActionResult",
                callID: "call_failed_1",
                state: {
                  status: "error",
                  input: { action_id: "impl", result: "x".repeat(3000) },
                  error: "ActionResult rejected an oversized result.",
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: child.id,
                type: "tool",
                tool: "ActionResult",
                callID: "call_failed_2",
                state: {
                  status: "error",
                  input: { action_id: "impl", status: "success" },
                  error:
                    'ActionResult input schema/parse failed. Raw tool input: {"result":"Error message: secret-result"} Parser error: Invalid input.\nError message: target_action_id is required.',
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              const ok = await SessionDelegation.fail({
                action: {} as never,
                agent: "backend",
                childID: child.id,
                error: new Error("ConflictError"),
                messageID: item.parent_message_id,
                parentAgent: "feature-planner",
                parentID: parent.id,
                runID: "apr_fallback_summary",
              })
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: {
                  child_session_id?: string
                  result_id?: string
                  carrier?: string
                  status?: string
                  fallback?: boolean
                  summary?: string
                  metadata?: unknown
                }[]
              }
              const summary = prompts.find((item) => item.agent === "summary")
              const body = summary?.parts?.find((part) => part.type === "text")?.text ?? ""

              expect(ok).toBe(true)
              expect(summary?.sessionID).not.toBe(child.id)
              expect(body).toContain("Child Transcript")
              expect(body).not.toContain("Failure Reason")
              expect(body).toContain("[ActionResult failure 1/2]")
              expect(body).toContain("[ActionResult failure 2/2]")
              expect(body).toContain('Input: {"action_id":"impl"}')
              expect(body).toContain("Omitted: result(string length=3000)")
              expect(body).not.toContain("x".repeat(200))
              expect(body).toContain('Input: {"action_id":"impl","status":"success"}')
              expect(body).toContain("Error: ActionResult input schema/parse failed.")
              expect(body).toContain("Error message: target_action_id is required.")
              expect(body).not.toContain("secret-result")
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("failed")
              expect(pctx.completed_delegations?.[0]?.carrier).toBe("fallback_summary")
              expect(pctx.completed_delegations?.[0]?.fallback).toBe(true)
              expect(pctx.completed_delegations?.[0]?.summary).toContain("Task result: created docs/audit.md")
              expect(pctx.completed_delegations?.[0]?.summary).not.toContain("ActionResult")
              expect(pctx.completed_delegations?.[0]?.summary).not.toContain("ConflictError")
              const raw = await SessionResult.raw(pctx.completed_delegations?.[0]?.result_id ?? "")
              const meta = JSON.stringify(raw)
              expect(meta).toContain("fallback_summary")
              expect(meta).toContain("confirmed_by_user")
              expect(meta).toContain("ActionResult input schema/parse failed")
              expect(meta).toContain("ConflictError")
              const updated = await MessageV2.get({ sessionID: parent.id, messageID: owner.id })
              expect(updated.info.role).toBe("user")
              const turn = updated.info.role === "user" ? updated.info.metadata?.turn : undefined
              const rows = (turn as { children?: { summary?: string; fallback?: boolean }[] })?.children
              expect(rows?.[0]?.summary).toContain("Task result: created docs/audit.md")
              expect(rows?.[0]?.fallback).toBe(true)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("fallback preview returns the latest assistant text from a delegated child", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const child = await Session.create({ agent: "backend" })
            const user = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              role: "user",
              time: { created: Date.now() },
              agent: "backend",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              tools: {},
              mode: "",
            } as MessageV2.User)) as MessageV2.User
            const first = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              parentID: user.id,
              role: "assistant",
              mode: "backend",
              agent: "backend",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              time: { created: Date.now(), completed: Date.now() },
              finish: "stop",
            })) as MessageV2.Assistant
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: first.id,
              sessionID: child.id,
              type: "text",
              text: "Older output",
              time: { start: Date.now(), end: Date.now() },
            } as MessageV2.TextPart)
            const last = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              parentID: user.id,
              role: "assistant",
              mode: "backend",
              agent: "backend",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              time: { created: Date.now(), completed: Date.now() },
              finish: "stop",
            })) as MessageV2.Assistant
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: last.id,
              sessionID: child.id,
              type: "text",
              text: "Latest output",
              time: { start: Date.now(), end: Date.now() },
            } as MessageV2.TextPart)

            const preview = await SessionDelegation.fallbackPreview({ sessionID: child.id })

            expect(preview.messageID).toBe(last.id)
            expect(preview.text).toBe("Latest output")
          },
        }),
    })
  })

  test("recovery notifies parent from a completed child assignment", async () => {
    await using tmp = await tmpdir()
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
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        text: "parent continued",
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
              const parent = await Session.create({})
              const child = await Session.create({ parentID: parent.id })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_restart",
                action_id: "review",
                action_title: "Review",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "technical-reviewer",
                result_policy: "summary",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    pending_delegations: {
                      [child.id]: item,
                      ses_other: {
                        ...item,
                        action_id: "verify",
                        action_title: "Verify",
                        child_session_id: "ses_other",
                        agent: "verifier",
                      },
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
                agent: "technical-reviewer",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "technical-reviewer",
                agent: "technical-reviewer",
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
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "text",
                text: "child finished after restart",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)

              await SessionDelegation.recover()
              await SessionDelegation.recover()

              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { child_session_id?: string; output?: string }[]
                pending_delegations?: Record<string, unknown>
              }
              const cctx = (await Session.get(child.id)).dsl_context?.protocol as {
                delegation?: { notified_at?: number; status?: string }
              }

              expect(inputs).toHaveLength(0)
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.pending_delegations?.ses_other).toBeDefined()
              expect(pctx.completed_delegations).toHaveLength(1)
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(cctx.delegation?.status).toBe("completed")
              expect(typeof cctx.delegation?.notified_at).toBe("number")
              expect(SessionStatus.get(parent.id).type).toBe("waiting_child")
              await Instance.dispose()
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("complete removes stale pending when child already has completion markers", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const parent = await Session.create({})
            const child = await Session.create({ parentID: parent.id })
            const msg = MessageID.ascending()
            const item = {
              type: "agent.delegation.assignment",
              version: "1",
              run_id: "apr_stale",
              action_id: "verify_stale",
              action_title: "Verify stale pending cleanup",
              parent_session_id: parent.id,
              parent_message_id: msg,
              parent_agent: "protocol-runner",
              child_session_id: child.id,
              agent: "technical-reviewer",
              result_policy: "summary",
              created_at: Date.now(),
            }
            const doneAt = Date.now()
            await Session.setDslContext({
              sessionID: parent.id,
              dsl_context: {
                protocol: {
                  pending_delegations: {
                    [child.id]: item,
                  },
                  completed_delegations: [
                    {
                      type: "agent.delegation.result",
                      version: "1",
                      status: "completed",
                      run_id: item.run_id,
                      action_id: item.action_id,
                      action_title: item.action_title,
                      parent_session_id: parent.id,
                      parent_message_id: item.parent_message_id,
                      parent_agent: item.parent_agent,
                      child_session_id: child.id,
                      agent: item.agent,
                      result_policy: item.result_policy,
                      completed_at: doneAt,
                      summary: "already done",
                      output: "already done",
                    },
                  ],
                },
              },
            })
            const user = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              role: "user",
              time: { created: Date.now() },
              agent: "technical-reviewer",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              tools: {},
              mode: "",
            } as MessageV2.User)) as MessageV2.User
            const done = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              parentID: user.id,
              role: "assistant",
              mode: "technical-reviewer",
              agent: "technical-reviewer",
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
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: done.id,
              sessionID: child.id,
              type: "text",
              text: "stale child result",
              time: { start: Date.now(), end: Date.now() },
            } as MessageV2.TextPart)

            await Session.setDslContext({
              sessionID: child.id,
              dsl_context: {
                protocol: {
                  delegation: {
                    ...item,
                    status: "completed",
                    completed_at: doneAt + 100,
                    completed_message_id: done.id,
                    output_ref: `session_delegation_result/${parent.id}/${child.id}`,
                    output: "child result",
                    notified_at: 1234,
                  },
                },
              },
            })

            await SessionDelegation.complete({ sessionID: child.id })

            const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
              pending_delegations?: Record<string, unknown>
            }
            const cctx = (await Session.get(child.id)).dsl_context?.protocol as {
              delegation?: { notified_at?: number }
            }
            expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
            expect(typeof cctx.delegation?.notified_at).toBe("number")
          },
        }),
    })
  })

  test("ActionResult tool calls close the delegated turn", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_action_tool_close",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "summary",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              SessionStatus.set(child.id, { type: "running" })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
                metadata: {
                  turn: {
                    kind: "user",
                    status: "running",
                    time: { queued: Date.now(), started: Date.now() },
                  },
                },
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "success",
                    scope: "task",
                    result: "implemented",
                    changed_files: "none",
                    verification: "done",
                    blockers: "",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)

              const stored = await MessageV2.get({ sessionID: child.id, messageID: user.id })
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { child_session_id?: string }[]
                pending_delegations?: Record<string, unknown>
              }
              if (stored.info.role !== "user") throw new Error("expected user message")
              expect(stored.info.metadata?.turn?.status).toBe("done")
              expect(stored.info.metadata?.turn?.reason).toBe("action_result")
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(SessionStatus.get(child.id).type).toBe("completed")
              expect(prompts).toHaveLength(1)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("worker ActionResult reply is a terminal non-satisfying handoff and is idempotent", async () => {
    await using tmp = await tmpdir()
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
        text: "parent consumed reply",
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
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_reply_terminal",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "summary",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    pending_delegations: { [child.id]: item },
                    runs: [
                      {
                        runID: "apr_reply_terminal",
                        title: "Reply terminal",
                        status: "blocked",
                        total: 1,
                        completed: 0,
                        actions: [
                          {
                            id: "impl",
                            title: "Implement",
                            operation: "backend",
                            executor: { type: "agent", target: "backend", capabilities: [] },
                            status: "blocked",
                            summary: "Delegated to backend.",
                          },
                        ],
                      },
                    ],
                  },
                },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              SessionStatus.set(child.id, { type: "running" })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl_reply",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "reply",
                    scope: "task",
                    result: "Need parent decision.",
                    changed_files: "none",
                    verification: "not run",
                    blockers: "Task scope is missing.",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(true)
              expect(await SessionDelegation.complete({ sessionID: child.id, messageID: done.id })).toBe(false)
              expect(SessionStatus.get(child.id)).toEqual({ type: "terminal_reply", message: "Need parent decision." })

              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { status?: string; satisfying?: boolean; result_id?: string }[]
                runs?: {
                  status?: string
                  completed?: number
                  actions?: { status?: string; result_status?: string; error?: string }[]
                }[]
              }
              expect(pctx.completed_delegations?.[0]?.status).toBe("terminal_reply")
              expect(pctx.completed_delegations?.[0]?.satisfying).toBe(false)
              expect(pctx.runs?.[0]?.status).toBe("blocked")
              expect(pctx.runs?.[0]?.completed).toBe(0)
              expect(pctx.runs?.[0]?.actions?.[0]?.status).toBe("blocked")
              expect(pctx.runs?.[0]?.actions?.[0]?.result_status).toBe("terminal_reply")
              expect(pctx.runs?.[0]?.actions?.[0]?.error).toContain("Need parent decision.")
              const rows = Database.use((db) =>
                db
                  .select()
                  .from(SessionResultTable)
                  .where(
                    and(
                      eq(SessionResultTable.parent_session_id, parent.id),
                      eq(SessionResultTable.child_session_id, child.id),
                      eq(SessionResultTable.run_id, "apr_reply_terminal"),
                      eq(SessionResultTable.action_id, "impl"),
                    ),
                  )
                  .all(),
              )
              expect(rows).toHaveLength(1)
              expect(rows[0]?.status).toBe("terminal_reply")
              expect(rows[0]?.satisfying).toBe(false)
              const dctx = (await Session.get(child.id)).dsl_context?.protocol as {
                delegation?: {
                  result_id?: string
                  status?: string
                  completed_at?: number
                  completed_message_id?: string
                  notified_at?: number
                }
              }
              expect(dctx.delegation?.result_id).toBeString()
              expect(dctx.delegation?.status).toBe("terminal_reply")
              expect(dctx.delegation?.completed_at).toBeNumber()
              expect(dctx.delegation?.completed_message_id).toBe(done.id)
              expect(dctx.delegation?.notified_at).toBeNumber()
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("ActionResult event keeps reply status authoritative", async () => {
    await using tmp = await tmpdir()
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
        text: "parent consumed verifier reply",
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
              SessionDelegation.init()
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend-verifier" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_event_reply",
                action_id: "impl_test",
                action_title: "Test fix",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend-verifier",
                result_policy: "summary",
                result_tool: "ActionResult",
                metadata: { verification: { worker: "impl" } },
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              SessionStatus.set(child.id, { type: "running" })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend-verifier",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend-verifier",
                agent: "backend-verifier",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl_test_reply",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "verifier",
                    action_id: "impl_test",
                    target_action_id: "impl",
                    status: "reply",
                    result: "Need worker artifact.",
                    issues: "Artifact path is missing.",
                    evidence: "No worker output reference was provided.",
                    worker_feedback: "Provide the artifact path before verification.",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)
              await Session.updateMessage(done)
              await new Promise((resolve) => setTimeout(resolve, 50))

              expect(SessionStatus.get(child.id)).toEqual({ type: "terminal_reply", message: "Need worker artifact." })
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { status?: string; satisfying?: boolean }[]
              }
              expect(pctx.completed_delegations?.[0]?.status).toBe("terminal_reply")
              expect(pctx.completed_delegations?.[0]?.satisfying).toBe(false)
              const row = Database.use((db) =>
                db
                  .select()
                  .from(SessionResultTable)
                  .where(
                    and(
                      eq(SessionResultTable.parent_session_id, parent.id),
                      eq(SessionResultTable.child_session_id, child.id),
                      eq(SessionResultTable.run_id, "apr_event_reply"),
                      eq(SessionResultTable.action_id, "impl_test"),
                    ),
                  )
                  .get(),
              )
              expect(row?.status).toBe("terminal_reply")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("completed delegated child accepts explicit user prompts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const parent = await Session.create({ agent: "protocol-runner" })
            const child = await Session.create({ parentID: parent.id, agent: "backend" })
            const old = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              role: "user",
              time: { created: Date.now() },
              agent: "backend",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              tools: {},
              mode: "",
              metadata: {
                turn: {
                  kind: "user",
                  status: "running",
                  time: { queued: Date.now(), started: Date.now() },
                },
              },
            } as MessageV2.User)) as MessageV2.User
            const done = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              parentID: old.id,
              role: "assistant",
              mode: "backend",
              agent: "backend",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              time: { created: Date.now(), completed: Date.now() },
              finish: "tool-calls",
            })) as MessageV2.Assistant
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: done.id,
              sessionID: child.id,
              type: "tool",
              callID: "call_impl",
              tool: "ActionResult",
              state: {
                status: "completed",
                input: {
                  kind: "action_result",
                  role: "worker",
                  action_id: "impl",
                  status: "success",
                  scope: "task",
                  result: "implemented",
                  changed_files: "none",
                  verification: "done",
                  blockers: "",
                },
                output: "Action result received.",
                title: "Action Result",
                metadata: { action_result: true },
                time: { start: Date.now(), end: Date.now() },
              },
            } as MessageV2.ToolPart)
            await Session.setDslContext({
              sessionID: child.id,
              dsl_context: {
                result: {
                  type: "session.action_result",
                  status: "completed",
                  action_id: "impl",
                  output_ref: `session_delegation_result/${parent.id}/${child.id}`,
                },
                protocol: {
                  delegation: {
                    type: "agent.delegation.assignment",
                    version: "1",
                    run_id: "apr_explicit_prompt",
                    action_id: "impl",
                    action_title: "Implement",
                    parent_session_id: parent.id,
                    parent_message_id: MessageID.ascending(),
                    parent_agent: "protocol-runner",
                    child_session_id: child.id,
                    agent: "backend",
                    result_policy: "summary",
                    result_tool: "ActionResult",
                    status: "completed",
                    completed_at: Date.now(),
                    completed_message_id: MessageID.ascending(),
                    created_at: Date.now(),
                  },
                },
              },
            })

            const before = (await Session.messages({ sessionID: child.id })).length
            const msg = await SessionPrompt.prompt({
              sessionID: child.id,
              noReply: true,
              parts: [{ type: "text", text: "follow up" }],
            })
            const after = (await Session.messages({ sessionID: child.id })).length
            const fixed = await MessageV2.get({ sessionID: child.id, messageID: old.id })

            if (fixed.info.role !== "user") throw new Error("expected user message")
            expect(fixed.info.metadata?.turn?.status).toBe("done")
            expect(fixed.info.metadata?.turn?.reason).toBe("action_result")
            expect(msg.info.role).toBe("user")
            expect(after).toBe(before + 1)
          },
        }),
    })
  })

  test("complete should still notify parent when child is already marked done but not yet delivered", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
      const part = (await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        text: "parent continued",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)) as MessageV2.TextPart
      return { info: msg, parts: [part] } as MessageV2.WithParts
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
              const msg = MessageID.ascending()
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_stale_fresh",
                action_id: "stale_fresh",
                action_title: "Stale but not done",
                parent_session_id: parent.id,
                parent_message_id: msg,
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "technical-reviewer",
                result_policy: "summary",
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
                    delegation: {
                      ...item,
                      status: "completed",
                      completed_at: Date.now(),
                      completed_message_id: MessageID.ascending(),
                      output_ref: `session_delegation_result/${parent.id}/${child.id}`,
                      output: "already done",
                    },
                  },
                },
              })

              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "technical-reviewer",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const done = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "technical-reviewer",
                agent: "technical-reviewer",
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
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: done.id,
                sessionID: child.id,
                type: "text",
                text: "already done",
                time: { start: Date.now(), end: Date.now() },
              } as MessageV2.TextPart)

              const result = await SessionDelegation.complete({ sessionID: child.id })
              expect(result).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
                completed_delegations?: { child_session_id?: string }[]
              }
              const cctx = (await Session.get(child.id)).dsl_context?.protocol as {
                delegation?: { notified_at?: number }
              }

              expect(prompts).toHaveLength(1)
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(typeof cctx.delegation?.notified_at).toBe("number")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("delegation runtime tool is available only to task delegation protocol agents", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const parent = await Session.create({})
            const child = await Session.create({ parentID: parent.id })
            await Session.setDslContext({
              sessionID: parent.id,
              dsl_context: {
                protocol: {
                  pending_delegations: {
                    [child.id]: {
                      type: "agent.delegation.assignment",
                      version: "1",
                      run_id: "apr_status",
                      action_id: "check",
                      action_title: "Check status",
                      parent_session_id: parent.id,
                      parent_message_id: MessageID.ascending(),
                      parent_agent: "feature-planner",
                      child_session_id: child.id,
                      agent: "technical-reviewer",
                      result_policy: "summary",
                      created_at: 1,
                    },
                  },
                  completed_delegations: [
                    {
                      type: "agent.delegation.result",
                      version: "1",
                      status: "completed",
                      run_id: "apr_status",
                      action_id: "done",
                      action_title: "Done status",
                      parent_session_id: parent.id,
                      parent_message_id: MessageID.ascending(),
                      parent_agent: "feature-planner",
                      child_session_id: SessionID.make("ses_done"),
                      agent: "verifier",
                      result_policy: "summary",
                      completed_at: 2,
                      summary: "verified",
                      output: "verified output",
                    },
                  ],
                },
              },
            })

            const planner = await Agent.get("feature-planner")
            const reviewer = await Agent.get("technical-reviewer")
            if (!planner || !reviewer) throw new Error("expected builtin agents")
            const msg = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: parent.id,
              parentID: MessageID.ascending(),
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
            const processor = {
              get message() {
                return msg
              },
              partFromToolCall() {
                return undefined
              },
            }
            const model = {
              id: ModelID.make("gpt-5.2"),
              providerID: ProviderID.make("openai"),
              api: { id: "openai", npm: "" },
            }
            const opts = {
              agent: planner,
              model,
              session: parent,
              processor,
              bypassAgentCheck: false,
              messages: [],
            } as unknown as Parameters<typeof RuntimeTools.build>[0]

            const runtime = await RuntimeTools.build(opts)
            const review = await RuntimeTools.build({ ...opts, agent: reviewer })
            const result = (await runtime.execute("delegation_status", {}, {
              toolCallId: "call_status",
              abortSignal: new AbortController().signal,
            } as never)) as { output?: string }
            const tree = (await runtime.execute("session_tree", {}, {
              toolCallId: "call_tree",
              abortSignal: new AbortController().signal,
            } as never)) as { output?: string }

            expect(runtime.catalog.map((item) => item.id)).toContain("delegation_status")
            expect(runtime.catalog.map((item) => item.id)).toContain("session_tree")
            expect(runtime.prompt).toContain("delegation_status")
            expect(review.catalog.map((item) => item.id)).not.toContain("delegation_status")
            expect(result.output).toContain(child.id)
            expect(result.output).toContain("pending")
            expect(result.output).toContain("ses_done")
            expect(result.output).toContain("completed")
            expect(result.output).toContain("verified")
            expect(result.output).not.toContain("verified output")
            expect(tree.output).toContain("Session tree has 2 sessions.")
            expect(tree.output).toContain(`Root session: ${parent.id}.`)
            expect(tree.output).toContain("idle (2):")
            expect(tree.output).toContain(parent.id)
            expect(tree.output).toContain(child.id)
            expect(tree.output).not.toContain("child_session_id")
            expect(tree.output).not.toContain("delegation")
            expect(tree.output).not.toContain("verified")
            expect(tree.output).not.toContain("verified output")
          },
        }),
    })
  })

  test("session_continue returns child continuation reply content", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
      const part = (await Session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: `child received: ${(input.parts?.[0] as MessageV2.TextPart | undefined)?.text ?? ""}`,
        time: { start: Date.now(), end: Date.now() },
      })) as MessageV2.TextPart
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
              await Session.setPermission({
                sessionID: parent.id,
                permission: [{ permission: "task", pattern: "*", action: "allow" }],
              })
              const planner = await Agent.get("feature-planner")
              if (!planner) throw new Error("expected feature-planner")
              const assistant = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: parent.id,
                role: "assistant",
                parentID: MessageID.ascending(),
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
              const processor = {
                get message() {
                  return assistant
                },
                partFromToolCall() {
                  return undefined
                },
              } as never
              const runtime = await RuntimeTools.build({
                agent: planner,
                model: {
                  id: ModelID.make("gpt-5.2"),
                  providerID: ProviderID.make("openai"),
                  api: { id: "openai", npm: "" },
                } as never,
                session: parent,
                tools: {},
                processor,
                bypassAgentCheck: false,
                messages: [],
              })

              const result = (await runtime.execute(
                "session_continue",
                {
                  child_session_id: child.id,
                  prompt: "continue child",
                },
                {
                  toolCallId: "call_continue",
                  abortSignal: new AbortController().signal,
                } as never,
              )) as { metadata?: { child_session_id?: string; message_id?: string }; output: string }

              expect(result.output).toContain('"kind": "session_continue_result"')
              const parsed = JSON.parse(result.output) as {
                kind: string
                child_session_id: string
                reply: string
                status?: unknown
              }
              expect(parsed.kind).toBe("session_continue_result")
              expect(parsed.child_session_id).toBe(child.id)
              expect(parsed.reply).toContain("continue child")
              expect(result.metadata?.child_session_id).toBe(child.id)
              expect(prompts).toHaveLength(1)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("recovery does not resubmit historical completed delegations", async () => {
    await using tmp = await tmpdir()
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      throw new Error("historical delegation should not prompt parent")
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
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_old",
                action_id: "old_task",
                action_title: "Old task",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "default",
                child_session_id: child.id,
                agent: "frontend",
                result_policy: "summary",
                created_at: 1,
              }
              const done = {
                type: "agent.delegation.result",
                version: "1",
                status: "completed",
                run_id: "apr_old",
                action_id: "old_task",
                action_title: "Old task",
                parent_session_id: parent.id,
                parent_message_id: item.parent_message_id,
                parent_agent: "default",
                child_session_id: child.id,
                agent: "frontend",
                result_policy: "summary",
                completed_at: 2,
                summary: "already delivered",
                output: "already delivered",
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    pending_delegations: {},
                    completed_delegations: [done],
                  },
                },
              })
              await Session.setDslContext({
                sessionID: child.id,
                dsl_context: {
                  protocol: {
                    delegation: {
                      ...item,
                      status: "completed",
                      completed_at: 2,
                      summary: "already delivered",
                      output: "already delivered",
                    },
                  },
                },
              })

              await SessionDelegation.recover()
              await SessionDelegation.recover()

              const cctx = (await Session.get(child.id)).dsl_context?.protocol as {
                delegation?: { notified_at?: number }
              }
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { notified_at?: number }[]
                pending_delegations?: Record<string, unknown>
              }

              expect(prompt).toHaveBeenCalledTimes(0)
              expect(typeof cctx.delegation?.notified_at).toBe("number")
              expect(typeof pctx.completed_delegations?.[0]?.notified_at).toBe("number")
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("failed terminal child status finalizes parent run with a synthetic result", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              SessionDelegation.init()
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "feature-planner" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_terminal_status",
                action_id: "plan",
                action_title: "Plan feature",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "feature-planner",
                result_policy: "structured",
                result_tool: "AgentProtocolOutput",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })

              SessionStatus.set(child.id, { type: "failed", message: "Child failed before returning a result." })
              await new Promise((resolve) => setTimeout(resolve, 20))

              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { child_session_id?: string; result_id?: string; summary?: string }[]
                delegation_notified_runs?: Record<string, number>
                pending_delegations?: Record<string, unknown>
              }

              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.summary).toContain("No structured child result was recorded")
              expect(pctx.completed_delegations?.[0]?.summary).toContain("Child failed before returning a result.")
              expect(pctx.completed_delegations?.[0]?.result_id).toBeString()
              expect(pctx.delegation_notified_runs?.apr_terminal_status).toBeNumber()
              const sent = prompts.filter((entry) => entry.sessionID === parent.id)
              expect(sent).toHaveLength(1)
              const text = sent[0]?.parts?.find((part) => part.type === "text")?.text
              expect(text).toContain("Delegated child sessions have finished")
              expect(text).toContain("`apr_terminal_status`")
              expect(text).toContain(child.id)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("interrupted delegated child settles with fallback result instead of staying pending", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
        text: "fallback summary",
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
              const child = await Session.create({ parentID: parent.id, agent: "technical-reviewer" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_interrupted",
                action_id: "review",
                action_title: "Review interrupted work",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "technical-reviewer",
                result_policy: "summary",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })

              SessionStatus.set(child.id, { type: "running" })
              SessionStatus.set(child.id, {
                type: "interrupted",
                prior: "running",
                message: "Session was running when the process stopped.",
              })

              expect(await SessionDelegation.settleInterrupted({ sessionID: child.id })).toBe(true)

              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { child_session_id?: string; result_id?: string; status?: string }[]
                pending_delegations?: Record<string, unknown>
              }
              const rec = await SessionResult.find({
                parentSessionID: parent.id,
                childSessionID: child.id,
                runID: "apr_interrupted",
                actionID: "review",
              })

              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.status).toBe("partial")
              expect(pctx.completed_delegations?.[0]?.result_id).toBeString()
              expect(rec?.status).toBe("partial")
              expect(prompts.some((entry) => entry.agent === "summary")).toBe(true)
              expect(prompts.some((entry) => entry.sessionID === parent.id)).toBe(true)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("completed terminal child status reuses a stored ActionResult before notifying parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
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
              SessionDelegation.init()
              const parent = await Session.create({ agent: "protocol-runner" })
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const item = {
                type: "agent.delegation.assignment",
                version: "1",
                run_id: "apr_terminal_action_result",
                action_id: "impl",
                action_title: "Implement",
                parent_session_id: parent.id,
                parent_message_id: MessageID.ascending(),
                parent_agent: "protocol-runner",
                child_session_id: child.id,
                agent: "backend",
                result_policy: "structured",
                result_tool: "ActionResult",
                created_at: Date.now(),
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [child.id]: item } } },
              })
              await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: item } } })
              const user = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                role: "user",
                time: { created: Date.now() },
                agent: "backend",
                model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
                tools: {},
                mode: "",
              } as MessageV2.User)) as MessageV2.User
              const msg = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID: child.id,
                parentID: user.id,
                role: "assistant",
                mode: "backend",
                agent: "backend",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ModelID.make("gpt-5.2"),
                providerID: ProviderID.make("openai"),
                time: { created: Date.now(), completed: Date.now() },
                finish: "tool-calls",
              })) as MessageV2.Assistant
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: child.id,
                type: "tool",
                callID: "call_impl",
                tool: "ActionResult",
                state: {
                  status: "completed",
                  input: {
                    kind: "action_result",
                    role: "worker",
                    action_id: "impl",
                    status: "success",
                    result: "race result",
                    changed_files: "none",
                    verification: "checked",
                    blockers: "none",
                  },
                  output: "Action result received.",
                  title: "Action Result",
                  metadata: { action_result: true },
                  time: { start: Date.now(), end: Date.now() },
                },
              } as MessageV2.ToolPart)

              SessionStatus.set(child.id, { type: "completed" })
              await new Promise((resolve) => setTimeout(resolve, 20))

              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                completed_delegations?: { child_session_id?: string; result_id?: string; summary?: string }[]
                pending_delegations?: Record<string, unknown>
              }
              const raw = await SessionResult.raw(pctx.completed_delegations?.[0]?.result_id ?? "")

              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(pctx.completed_delegations?.[0]?.summary).toContain("race result")
              expect(pctx.completed_delegations?.[0]?.summary).not.toContain("No structured child result was recorded")
              expect((raw as { carrier?: string }).carrier).toBe("action_result")
              const sent = prompts.filter((entry) => entry.sessionID === parent.id)
              expect(sent).toHaveLength(1)
              expect(sent[0]?.parts?.some((part) => part.type === "text" && part.text.includes("race result"))).toBe(
                true,
              )
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })
})
