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

  test("aborts selected sessions and restores interrupted sessions without sending a message by default", async () => {
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
            const loops: Parameters<typeof SessionPrompt.loop>[0][] = []
            const loop = spyOn(SessionPrompt, "loop").mockImplementation((async (input: Parameters<typeof SessionPrompt.loop>[0]) => {
              loops.push(input)
              return undefined
            }) as never)
            const prompt = spyOn(SessionPrompt, "prompt")

            try {
              const abort = await app.request("/session/tree/abort", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [child.id], source_session: parent.id, reason: "bulk stop" }),
              })
              expect(abort.status).toBe(200)
              expect(SessionStatus.get(child.id)).toEqual({ type: "aborted", message: "bulk stop" })

              const resume = await app.request("/session/tree/resume", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [child.id, idle.id], source_session: parent.id, reason: "bulk resume" }),
              })
              expect(resume.status).toBe(200)
              expect(await resume.json()).toEqual({ resumed: 1 })
              expect(loops).toEqual([{ sessionID: child.id }])
              expect(prompt).not.toHaveBeenCalled()
              expect(SessionStatus.get(child.id)).toEqual({ type: "running" })
              expect(await Session.messages({ sessionID: child.id, limit: 1 })).toHaveLength(0)
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
})
