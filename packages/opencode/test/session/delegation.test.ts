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

describe("SessionDelegation", () => {
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
              expect(pctx.completed_delegations?.[0]?.summary).toContain("status aborted")
              expect(messages.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "text" && part.text.includes("cancel_delegated_task")))).toBe(true)
              expect(prompts[0]?.sessionID).toBe(parent.id)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("Partial: 0"))).toBe(true)
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("ActionResult"))).toBe(true)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(false)
              expect(pctx.pending_delegations?.[child.id]).toBeDefined()
              expect(pctx.completed_delegations ?? []).toHaveLength(0)
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
            task_background: "Feature planner was delegated by a parent session.",
            task_content: "Plan and coordinate nested feature work.",
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
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("Nested feature work is complete"))).toBe(true)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("records child results and notifies parent only after all sibling children end", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
            task_background: "Sibling child task.",
            task_content: action,
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
                action_id: "two",
                action_title: "Second child",
                child_session_id: two.id,
              }
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: { protocol: { pending_delegations: { [one.id]: first, [two.id]: second } } },
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
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("## Child Results"))).toBe(true)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(false)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("first done"))).toBe(true)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("second done"))).toBe(true)
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
            task_background: "Manual submit task.",
            task_content: action,
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

              expect(await SessionDelegation.submit({ sessionID: parent.id, runID: "manual_submit", force: true })).toBe(true)
              expect(prompts).toHaveLength(1)
              expect(prompts[0]?.sessionID).toBe(parent.id)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("child done"))).toBe(true)
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("status interrupted"))).toBe(true)
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

  test("worker ActionResult runs verifier gates serially before notifying parent", async () => {
    await using tmp = await tmpdir()
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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

    const done = async (
      sessionID: SessionID,
      agent: string,
      input: Record<string, unknown>,
    ) => {
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
                            executor: { type: "agent", target: "backend-verifier", capabilities: ["verification", "test"] },
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
                            executor: { type: "agent", target: "backend-verifier", capabilities: ["verification", "review"] },
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
                task_background: "Needed backend work",
                task_content: "Implement",
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
              expect(prompts[0]?.parts?.some((part) => part.type === "text" && part.text.includes("impl_test"))).toBe(true)
              const testSession = prompts[0]!.sessionID
              const test = (await Session.get(testSession)).dsl_context?.protocol as { delegation?: { action_id?: string } }
              expect((await Session.get(testSession)).parentID).toBe(worker.id)
              expect(test.delegation?.action_id).toBe("impl_test")

              await done(testSession, "backend-verifier", {
                kind: "action_result",
                role: "verifier",
                action_id: "impl_test",
                target_action_id: "impl",
                verification_role: "test",
                status: "pass",
                result: "Tests pass",
                issues: "none",
                evidence: "bun test",
                worker_feedback: "Accepted",
              })
              expect(await SessionDelegation.complete({ sessionID: testSession })).toBe(true)
              expect(prompts).toHaveLength(2)
              expect(prompts[1]?.agent).toBe("backend-verifier")
              expect(prompts[1]?.sessionID).not.toBe(testSession)
              expect(prompts[1]?.parts?.some((part) => part.type === "text" && part.text.includes("impl_review"))).toBe(true)
              const reviewSession = prompts[1]!.sessionID
              expect((await Session.get(reviewSession)).parentID).toBe(worker.id)

              await done(reviewSession, "backend-verifier", {
                kind: "action_result",
                role: "verifier",
                action_id: "impl_review",
                target_action_id: "impl",
                verification_role: "review",
                status: "pass",
                result: "Review pass",
                issues: "none",
                evidence: "reviewed diff",
                worker_feedback: "Accepted",
              })
              const notified = await SessionDelegation.complete({ sessionID: reviewSession })
              expect(notified || prompts.length === 3).toBe(true)
              expect(prompts).toHaveLength(3)
              expect(prompts[2]?.sessionID).toBe(parent.id)
              expect(prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(false)
              expect(prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("## Child Results"))).toBe(true)
              expect(prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("Tests pass"))).toBe(true)
              expect(prompts[2]?.parts?.some((part) => part.type === "text" && part.text.includes("Review pass"))).toBe(true)
              const pctx = (await Session.get(parent.id)).dsl_context?.protocol as {
                pending_delegations?: Record<string, unknown>
              }
              expect(Object.keys(pctx.pending_delegations ?? {})).toHaveLength(0)
              const wctx = (await Session.get(worker.id)).dsl_context as {
                result?: { action_id?: string; status?: string; action_result?: { role?: string } }
              }
              expect(wctx.result?.action_id).toBe("impl")
              expect(wctx.result?.status).toBe("completed")
              expect(wctx.result?.action_result?.role).toBe("worker")

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
              const out = (await runtime.execute("session_result", {
                child_session_id: worker.id,
                include_output: true,
              }, {
                toolCallId: "call_result",
                abortSignal: new AbortController().signal,
              } as never)) as { output: string }
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

  test("ActionResult stores trailing final text as result when result field is empty", async () => {
    await using tmp = await tmpdir()
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
              run_id: "apr_trailing_result",
              action_id: "survey",
              action_title: "Survey",
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
            const call = {
              kind: "action_result",
              role: "worker",
              action_id: "survey",
              status: "success",
              scope: "task",
              summary: "Survey completed",
              task_background: "Need a report",
              task_content: "Survey",
              changed_files: "",
              verification: "read-only",
              blockers: "",
            }
            const first = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              role: "user",
              time: { created: Date.now() },
              agent: "backend",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
              tools: {},
              mode: "",
            } as MessageV2.User)) as MessageV2.User
            const tool = (await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              parentID: first.id,
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
              messageID: tool.id,
              sessionID: child.id,
              type: "tool",
              callID: "call_survey",
              tool: "ActionResult",
              state: {
                status: "completed",
                input: call,
                output: "Action result received.",
                title: "Action Result",
                metadata: { action_result: true },
                time: { start: Date.now(), end: Date.now() },
              },
            } as MessageV2.ToolPart)
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
            const final = (await Session.updateMessage({
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
              messageID: final.id,
              sessionID: child.id,
              type: "text",
              text: "# Full survey report\n\nEvidence and conclusions.",
              time: { start: Date.now(), end: Date.now() },
            } as MessageV2.TextPart)

            expect(await SessionDelegation.complete({ sessionID: child.id, messageID: final.id })).toBe(true)
            const ctx = (await Session.get(child.id)).dsl_context as {
              result?: { action_result?: { result?: string }; output_ref?: string }
            }
            expect(ctx.result?.action_result?.result).toContain("Full survey report")

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
            const out = (await runtime.execute("session_result", {
              child_session_id: child.id,
              include_output: true,
            }, {
              toolCallId: "call_result",
              abortSignal: new AbortController().signal,
            } as never)) as { output: string }
            const parsed = JSON.parse(out.output) as {
              result?: { action_result?: { result?: string }; output?: string }
            }
            expect(parsed.result?.action_result?.result).toContain("Full survey report")
            expect(parsed.result?.output).toContain("Full survey report")
          },
        }),
    })
  })

  test("recovery notifies parent from a completed child assignment", async () => {
    await using tmp = await tmpdir()
    const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
                    task_background: "delegated",
                    task_content: "impl",
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
                  task_background: "delegated",
                  task_content: "impl",
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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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
              const done = await Session.updateMessage({
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
              }) as MessageV2.Assistant
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
            const result = await runtime.execute("delegation_status", {}, {
              toolCallId: "call_status",
              abortSignal: new AbortController().signal,
            } as never) as { output?: string }
            const tree = await runtime.execute("session_tree", {}, {
              toolCallId: "call_tree",
              abortSignal: new AbortController().signal,
            } as never) as { output?: string }

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
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
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

              const result = (await runtime.execute("session_continue", {
                child_session_id: child.id,
                prompt: "continue child", 
              }, {
                toolCallId: "call_continue",
                abortSignal: new AbortController().signal,
              } as never)) as { metadata?: { child_session_id?: string; message_id?: string }; output: string }

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
})
