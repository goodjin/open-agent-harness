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
import { tmpdir } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { RuntimeTools } from "../../src/session/runtime-tools"

describe("SessionDelegation", () => {
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

              expect(inputs).toHaveLength(1)
              expect(inputs[0]?.sessionID).toBe(parent.id)
              expect(inputs[0]?.agent).toBe("protocol-runner")
              expect(inputs[0]?.parts?.some((part) => part.type === "text" && part.text.includes("<agent-delegation-result>"))).toBe(true)
              expect(inputs[0]?.parts?.some((part) => part.type === "text" && part.text.includes("child finished after restart"))).toBe(true)
              expect(pctx.pending_delegations?.[child.id]).toBeUndefined()
              expect(pctx.completed_delegations).toHaveLength(1)
              expect(pctx.completed_delegations?.[0]?.child_session_id).toBe(child.id)
              expect(cctx.delegation?.status).toBe("completed")
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

            expect(runtime.catalog.map((item) => item.id)).toContain("delegation_status")
            expect(runtime.prompt).toContain("delegation_status")
            expect(review.catalog.map((item) => item.id)).not.toContain("delegation_status")
            expect(result.output).toContain(child.id)
            expect(result.output).toContain("pending")
            expect(result.output).toContain("ses_done")
            expect(result.output).toContain("completed")
            expect(result.output).toContain("verified")
            expect(result.output).not.toContain("verified output")
          },
        }),
    })
  })
})
