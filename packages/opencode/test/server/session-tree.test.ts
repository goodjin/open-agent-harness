import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { SessionStatus } from "../../src/session/status"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

describe("Session tree projection", () => {
  test("returns lightweight tree nodes with status and stats", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const parent = await Session.create({ title: "tree-root" })
            const child = await Session.create({ title: "tree-child", parentID: parent.id })
            SessionStatus.set(child.id, { type: "blocked", message: "needs input" })
            const app = Server.Default()

            const res = await app.request(`/session/tree?root=${parent.id}`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as { nodes: Record<string, unknown>[] }

            expect(body.nodes).toHaveLength(2)
            expect(body.nodes.find((item) => item.id === child.id)).toMatchObject({
              id: child.id,
              parent_id: parent.id,
              root_id: parent.id,
              title: "tree-child",
              status: { type: "blocked", message: "needs input" },
              stats: { messages: 0 },
            })
            expect(body.nodes[0]).not.toHaveProperty("dsl_context")
            expect(body.nodes[0]).not.toHaveProperty("permission")
            expect(body.nodes[0]).not.toHaveProperty("share")

            await Session.remove(parent.id)
          },
        }),
    })
  })

  test("updates title, agent, and model preferences in batch", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const parent = await Session.create({ title: "tree-root" })
            const child = await Session.create({ title: "tree-child", parentID: parent.id })
            const idle = await Session.create({ title: "tree-idle", parentID: parent.id })
            const app = Server.Default()

            const res = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ids: [child.id],
                title: "renamed-child",
                agent: "build",
                model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
              }),
            })
            expect(res.status).toBe(200)
            const updated = await Session.get(child.id)
            expect(updated.title).toBe("renamed-child")
            expect(updated.agent).toBe("build")
            expect(updated.model).toEqual({
              providerID: ProviderID.make("anthropic"),
              modelID: ModelID.make("claude-sonnet-4"),
            })
            expect(JSON.stringify(updated.dsl_context ?? {})).not.toContain("session_tree")

            const tree = await app.request(`/session/tree?root=${parent.id}`)
            const body = (await tree.json()) as { nodes: Record<string, unknown>[] }
            expect(body.nodes.find((item) => item.id === child.id)).toMatchObject({
              agent: "build",
              model: { provider_id: "anthropic", model_id: "claude-sonnet-4" },
            })

            await Session.remove(parent.id)
          },
        }),
    })
  })

  test("does not project historical message model as session model", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const parent = await Session.create({ title: "tree-root" })
            const child = await Session.create({ title: "tree-child", parentID: parent.id })
            await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: child.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: {
                providerID: ProviderID.make("deepseek"),
                modelID: ModelID.make("deepseek-v4-flash"),
              },
              tools: {},
              mode: "",
            } as MessageV2.User)
            const app = Server.Default()

            const first = await app.request(`/session/tree?root=${parent.id}`)
            const stale = (await first.json()) as { nodes: Record<string, unknown>[] }
            expect(stale.nodes.find((item) => item.id === child.id)).not.toHaveProperty("model")

            await Session.setModel({
              sessionID: child.id,
              model: {
                providerID: ProviderID.make("minimax-cn-coding-plan"),
                modelID: ModelID.make("MiniMax-M3"),
              },
            })
            const next = await app.request(`/session/tree?root=${parent.id}`)
            const body = (await next.json()) as { nodes: Record<string, unknown>[] }
            expect(body.nodes.find((item) => item.id === child.id)).toMatchObject({
              model: { provider_id: "minimax-cn-coding-plan", model_id: "MiniMax-M3" },
            })

            await Session.remove(parent.id)
          },
        }),
    })
  })

  test("restores recoverable scheduler states without sending a message by default", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const parent = await Session.create({ title: "tree-root" })
            const child = await Session.create({ title: "tree-interrupted", parentID: parent.id })
            const limited = await Session.create({ title: "tree-limited", parentID: parent.id })
            const idle = await Session.create({ title: "tree-idle", parentID: parent.id })
            const app = Server.Default()
            const loops: Parameters<typeof SessionPrompt.loop>[0][] = []
            const loop = spyOn(SessionPrompt, "loop").mockImplementation((async (input: Parameters<typeof SessionPrompt.loop>[0]) => {
              loops.push(input)
              return undefined
            }) as never)
            const prompt = spyOn(SessionPrompt, "prompt")

            try {
              SessionStatus.set(child.id, { type: "interrupted", prior: "running", message: "process stopped" })
              SessionStatus.set(limited.id, { type: "running" })
              SessionStatus.set(limited.id, {
                type: "rate_limited",
                providerID: "p",
                modelID: "m",
                scope: "model",
                active: 1,
                limit: 1,
                queued: 1,
              })

              const resume = await app.request("/session/tree/resume", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [child.id, limited.id, idle.id], source_session: parent.id, reason: "bulk resume" }),
              })
              expect(resume.status).toBe(200)
              expect(await resume.json()).toEqual({ resumed: 2 })
              expect(loops).toEqual([{ sessionID: child.id }, { sessionID: limited.id }])
              expect(prompt).not.toHaveBeenCalled()
              expect(SessionStatus.get(child.id)).toEqual({ type: "running" })
              expect(SessionStatus.get(limited.id)).toEqual({ type: "running" })
              expect(await Session.messages({ sessionID: child.id, limit: 1 })).toHaveLength(0)
              expect(await Session.messages({ sessionID: limited.id, limit: 1 })).toHaveLength(0)
              expect(await Session.messages({ sessionID: idle.id, limit: 1 })).toHaveLength(0)
            } finally {
              loop.mockRestore()
              prompt.mockRestore()
              await Session.remove(parent.id)
            }
          },
        }),
    })
  })

  test("does not restore stopped sessions without a resume message", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({ title: "tree-aborted" })
            SessionStatus.set(session.id, { type: "aborted", message: "bulk stop" })
            const app = Server.Default()
            const loop = spyOn(SessionPrompt, "loop")
            const prompt = spyOn(SessionPrompt, "prompt")

            try {
              const res = await app.request("/session/tree/resume", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [session.id], mode: "restore" }),
              })
              expect(res.status).toBe(200)
              expect(await res.json()).toEqual({ resumed: 0 })
              expect(loop).not.toHaveBeenCalled()
              expect(prompt).not.toHaveBeenCalled()
              expect(SessionStatus.get(session.id)).toEqual({ type: "aborted", message: "bulk stop" })
            } finally {
              loop.mockRestore()
              prompt.mockRestore()
              await Session.remove(session.id)
            }
          },
        }),
    })
  })

  test("sends a structured custom resume message when message mode is selected", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const parent = await Session.create({ title: "tree-root" })
            const idle = await Session.create({ title: "tree-idle", parentID: parent.id })
            await Session.setAgent({ sessionID: idle.id, agent: "build" })
            const app = Server.Default()
            const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
            const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
              input: Parameters<typeof SessionPrompt.prompt>[0],
            ) => {
              inputs.push(input)
              return undefined
            }) as never)
            const loop = spyOn(SessionPrompt, "loop")

            try {
              const res = await app.request("/session/tree/resume", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ids: [idle.id],
                  source_session: parent.id,
                  reason: "bulk resume",
                  include_completed: true,
                  mode: "message",
                  message: "继续检查剩余任务",
                }),
              })
              expect(res.status).toBe(200)
              expect(await res.json()).toEqual({ resumed: 1 })
              expect(loop).not.toHaveBeenCalled()
              expect(inputs).toHaveLength(1)
              expect(inputs[0]?.agent).toBe("build")
              const text = inputs[0]?.parts.find((part) => part.type === "text")?.text
              expect(text).toContain("[Session Command]")
              expect(text).toContain("source: user")
              expect(text).toContain(`source_session: ${parent.id}`)
              expect(text).toContain(`target_session: ${idle.id}`)
              expect(text).toContain("intent: resume_aborted_session")
              expect(text).toContain("reason: bulk resume")
              expect(text).toContain("继续检查剩余任务")
              expect(inputs[0]?.metadata).toMatchObject({
                command: {
                  source: "user",
                  source_session: parent.id,
                  target_session: idle.id,
                  intent: "resume_aborted_session",
                },
              })
              expect(SessionStatus.get(idle.id)).toEqual({ type: "running" })
            } finally {
              prompt.mockRestore()
              loop.mockRestore()
              await Session.remove(parent.id)
            }
          },
        }),
    })
  })

  test("sends a structured resume message for stopped sessions", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({ title: "tree-failed" })
            SessionStatus.set(session.id, { type: "failed", message: "tool failed" })
            const app = Server.Default()
            const inputs: Parameters<typeof SessionPrompt.prompt>[0][] = []
            const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
              input: Parameters<typeof SessionPrompt.prompt>[0],
            ) => {
              inputs.push(input)
              return undefined
            }) as never)
            const loop = spyOn(SessionPrompt, "loop")

            try {
              const res = await app.request("/session/tree/resume", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ids: [session.id],
                  mode: "message",
                  reason: "manual continue",
                  message: "继续修复失败的步骤",
                }),
              })
              expect(res.status).toBe(200)
              expect(await res.json()).toEqual({ resumed: 1 })
              expect(loop).not.toHaveBeenCalled()
              expect(inputs).toHaveLength(1)
              expect(inputs[0]?.parts.find((part) => part.type === "text")?.text).toContain("继续修复失败的步骤")
              expect(SessionStatus.get(session.id)).toEqual({ type: "running" })
            } finally {
              prompt.mockRestore()
              loop.mockRestore()
              await Session.remove(session.id)
            }
          },
        }),
    })
  })

  test("skips completed sessions in message mode unless explicitly included", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const parent = await Session.create({ title: "tree-root" })
            const idle = await Session.create({ title: "tree-idle", parentID: parent.id })
            SessionStatus.set(idle.id, { type: "completed" })
            const app = Server.Default()
            const prompt = spyOn(SessionPrompt, "prompt")

            try {
              const res = await app.request("/session/tree/resume", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [idle.id], mode: "message" }),
              })
              expect(res.status).toBe(200)
              expect(await res.json()).toEqual({ resumed: 0 })
              expect(prompt).not.toHaveBeenCalled()
            } finally {
              prompt.mockRestore()
              await Session.remove(parent.id)
            }
          },
        }),
    })
  })

  test("rejects agent change without confirm when a bound agent already exists", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({ title: "agent-conflict" })
            const app = Server.Default()

            // initial assignment: confirm not required (no prior bound agent)
            const first = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ids: [session.id], agent: "build" }),
            })
            expect(first.status).toBe(200)

            // attempt to overwrite without confirm: must 409
            const conflict = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ids: [session.id], agent: "plan" }),
            })
            expect(conflict.status).toBe(409)
            const conflictBody = (await conflict.json()) as { data?: { message?: string }; message?: string }
            const conflictMsg = conflictBody.data?.message ?? conflictBody.message ?? ""
            expect(conflictMsg).toContain("build")
            expect(conflictMsg).toContain("plan")

            // attempt to overwrite with the same agent: must 200 (no-op overwrite)
            const same = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ids: [session.id], agent: "build" }),
            })
            expect(same.status).toBe(200)

            // attempt to overwrite with a different agent + confirm=true: must 200
            const confirmed = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ids: [session.id], agent: "plan", confirm: true }),
            })
            expect(confirmed.status).toBe(200)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("rejects model change without confirm when a bound model already exists", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({ title: "model-conflict" })
            const app = Server.Default()

            const first = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ids: [session.id],
                model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
              }),
            })
            expect(first.status).toBe(200)

            const conflict = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ids: [session.id],
                model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
              }),
            })
            expect(conflict.status).toBe(409)
            const body = (await conflict.json()) as { data?: { message?: string }; message?: string }
            const msg = body.data?.message ?? body.message ?? ""
            expect(msg).toContain("opencode/kimi-k2.5-free")
            expect(msg).toContain("anthropic/claude-sonnet-4")

            const same = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ids: [session.id],
                model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
              }),
            })
            expect(same.status).toBe(200)

            const confirmed = await app.request("/session/tree/sessions", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ids: [session.id],
                model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
                confirm: true,
              }),
            })
            expect(confirmed.status).toBe(200)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("rejects async prompt model changes before accepting the request", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({ title: "prompt-model-conflict" })
            await Session.setModel({
              sessionID: session.id,
              model: {
                providerID: ProviderID.make("opencode"),
                modelID: ModelID.make("kimi-k2.5-free"),
              },
            })
            const app = Server.Default()

            const conflict = await app.request(`/session/${session.id}/prompt_async`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
                noReply: true,
                parts: [{ type: "text", text: "wrong model" }],
              }),
            })
            expect(conflict.status).toBe(409)
            expect((await Session.get(session.id)).model).toEqual({
              providerID: ProviderID.make("opencode"),
              modelID: ModelID.make("kimi-k2.5-free"),
            })

            const confirmed = await app.request(`/session/${session.id}/prompt_async`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
                confirm: true,
                noReply: true,
                parts: [{ type: "text", text: "confirmed model" }],
              }),
            })
            expect(confirmed.status).toBe(204)
            expect((await Session.get(session.id)).model).toEqual({
              providerID: ProviderID.make("anthropic"),
              modelID: ModelID.make("claude-sonnet-4"),
            })
            for (let i = 0; i < 10; i++) {
              if ((await Session.messages({ sessionID: session.id })).length > 0) break
              await new Promise((resolve) => setTimeout(resolve, 10))
            }

            await Session.remove(session.id)
          },
        }),
    })
  })
})
