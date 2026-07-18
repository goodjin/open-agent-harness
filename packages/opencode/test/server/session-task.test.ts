import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionTask } from "../../src/session/task"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionTaskHandoff } from "../../src/session/task-handoff"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(resetDatabase)

describe("session task endpoints", () => {
  test("generated OpenAPI describes the task lifecycle without exposing target controls", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()
    const paths = spec.paths as Record<string, Record<string, { operationId?: string; requestBody?: unknown }>>

    expect(paths["/session/{sessionID}/task"]?.get?.operationId).toBe("session.task")
    expect(paths["/session/{sessionID}/task/history"]?.get?.operationId).toBe("session.task.history")
    expect(paths["/session/{sessionID}/task/revisions/{version}"]?.get?.operationId).toBe(
      "session.task.revision",
    )
    expect(paths["/session/{sessionID}/task/update/confirm"]?.post?.operationId).toBe(
      "session.task.update.confirm",
    )
    expect(paths["/session/{sessionID}/task/handoff/{handoffID}/confirm"]?.post?.operationId).toBe(
      "session.task.handoff.confirm",
    )
    expect(JSON.stringify(paths["/session/{sessionID}/task/update/confirm"]?.post?.requestBody)).not.toContain(
      "target_session_id",
    )
    expect(JSON.stringify(paths["/session/{sessionID}/task/handoff/{handoffID}/confirm"]?.post?.requestBody)).not.toContain(
      "assignment_id",
    )
  })

  test("reads the current task, compact history, and a complete archived revision", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_reads"),
          fn: async () => {
            const session = await Session.create({})
            const first = await SessionTask.route({
              sessionID: session.id,
              runID: "run_task_old",
              legacy: { title: "Original", body: "Original body" },
              actions: [action("old_done", "completed")],
            })
            if (first.type !== "execute") throw new Error("task missing")
            const draft = await SessionTask.draft({
              taskID: first.task.id,
              title: "Revised",
              body: "Revised body",
              reason: "Change scope",
            })
            await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
            const app = Server.Default()

            const current = await app.request(`/session/${session.id}/task`)
            expect(current.status).toBe(200)
            expect(await current.json()).toMatchObject({
              id: first.task.id,
              session_id: session.id,
              title: "Revised",
              version: 2,
              body: "Revised body",
            })

            const history = await app.request(`/session/${session.id}/task/history`)
            expect(history.status).toBe(200)
            const items = (await history.json()) as Record<string, unknown>[]
            expect(items).toHaveLength(1)
            expect(items[0]).toMatchObject({ version: 1, status: "archived", title: "Original" })
            expect(items[0]).not.toHaveProperty("body")
            expect(items[0]).not.toHaveProperty("workflow")
            expect(items[0]).not.toHaveProperty("result")

            const archived = await app.request(`/session/${session.id}/task/revisions/1`)
            expect(archived.status).toBe(200)
            expect(await archived.json()).toMatchObject({
              session_id: session.id,
              version: 1,
              status: "archived",
              body: "Original body",
            })
          },
        }),
    })
  })

  test("returns scoped task read errors", async () => {
    await using tmp = await tmpdir({ git: true })
    await using peer = await tmpdir({ git: true })
    const foreign = await Instance.provide({
      directory: peer.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_foreign"),
          fn: () => Session.create({}),
        }),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_errors"),
          fn: async () => {
            const empty = await Session.create({})
            const session = await Session.create({})
            await SessionTask.route({
              sessionID: session.id,
              runID: "run_task_errors",
              legacy: { title: "Task", body: "Body" },
              actions: [],
            })
            const app = Server.Default()

            expect((await app.request(`/session/ses_missing/task`)).status).toBe(404)
            expect((await app.request(`/session/${foreign.id}/task`)).status).toBe(403)
            expect((await app.request(`/session/${empty.id}/task`)).status).toBe(404)
            expect((await app.request(`/session/${session.id}/task/revisions/9`)).status).toBe(404)
          },
        }),
    })
  })

  test("adds optional task summaries to session list and tree responses", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_summary"),
          fn: async () => {
            const root = await Session.create({ title: "root" })
            const child = await Session.create({ title: "child", parentID: root.id })
            await SessionTask.route({
              sessionID: root.id,
              runID: "run_task_summary",
              legacy: { title: "Summarized task", body: "Body" },
              actions: [action("done", "completed"), action("todo", "pending")],
            })
            const app = Server.Default()

            const listed = (await (await app.request("/session")).json()) as Record<string, unknown>[]
            expect(listed.find((item) => item.id === root.id)).toMatchObject({
              task: {
                title: "Summarized task",
                version: 1,
                status: "running",
                completed_actions: 1,
                total_actions: 2,
              },
            })
            expect(listed.find((item) => item.id === child.id)).not.toHaveProperty("task")

            const tree = (await (await app.request(`/session/tree?root=${root.id}`)).json()) as {
              nodes: Record<string, unknown>[]
            }
            expect(tree.nodes.find((item) => item.id === root.id)).toMatchObject({
              task: {
                title: "Summarized task",
                version: 1,
                completed_actions: 1,
                total_actions: 2,
              },
            })
            expect(tree.nodes.find((item) => item.id === child.id)).not.toHaveProperty("task")
          },
        }),
    })
  })

  test("confirms and cancels task updates from server-owned proposal state", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_session_task_update_confirm"),
            fn: async () => {
              const session = await Session.create({})
              const peer = await Session.create({})
              const task = await SessionTask.route({
                sessionID: session.id,
                runID: "run_update_old",
                legacy: { title: "Original", body: "Original" },
                actions: [],
              })
              const other = await SessionTask.route({
                sessionID: peer.id,
                runID: "run_update_peer",
                legacy: { title: "Peer", body: "Peer" },
                actions: [],
              })
              if (task.type !== "execute" || other.type !== "execute") throw new Error("task missing")
              const draft = await SessionTask.draft({ taskID: task.task.id, title: "Current", body: "Current" })
              await SessionTask.activate({ taskID: task.task.id, revisionID: draft.id })
              const current = await SessionTask.get(session.id)
              if (!current) throw new Error("current task missing")
              const messageID = await message(session.id)
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_update",
                actionID: "confirm_update",
                title: "Revised",
                plan: "Revised body",
                op: "update",
                target: "self",
              })
              const app = Server.Default()

              const crossed = await app.request(`/session/${peer.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_update:confirm_update",
                  revision_id: current.revision.id,
                  action: "confirm",
                }),
              })
              expect(crossed.status).toBe(403)

              const proposalCrossed = await app.request(`/session/${peer.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_update:confirm_update",
                  revision_id: other.revision.id,
                  action: "confirm",
                }),
              })
              expect(proposalCrossed.status).toBe(403)

              const stale = await app.request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_update:confirm_update",
                  revision_id: task.revision.id,
                  action: "confirm",
                }),
              })
              expect(stale.status).toBe(409)

              const confirmed = await Promise.all(
                [0, 1].map(() =>
                  app.request(`/session/${session.id}/task/update/confirm`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      proposal_id: "run_update:confirm_update",
                      revision_id: current.revision.id,
                      action: "confirm",
                    }),
                  }),
                ),
              )
              expect(confirmed.map((res) => res.status)).toEqual([200, 200])
              const replies = await Promise.all(confirmed.map((res) => res.json()))
              expect(replies[0]).toMatchObject({
                proposal_id: "run_update:confirm_update",
                revision_id: current.revision.id,
                action: "confirm",
              })
              expect(replies[0].assignment_id).toBe(replies[1].assignment_id)
              expect(prompt).toHaveBeenCalledTimes(1)
              expect(await SessionAssignment.bySource({
                sessionID: session.id,
                runID: "run_update",
                actionID: "confirm_update",
              })).toMatchObject({ status: "running", target: "self" })

              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_cancel",
                actionID: "confirm_cancel",
                title: "Cancelled",
                plan: "Cancelled body",
                op: "update",
                target: "self",
              })
              const cancelled = await app.request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_cancel:confirm_cancel",
                  revision_id: current.revision.id,
                  action: "cancel",
                }),
              })
              expect(cancelled.status).toBe(200)
              expect(await SessionAssignment.bySource({
                sessionID: session.id,
                runID: "run_cancel",
                actionID: "confirm_cancel",
              })).toBeUndefined()
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("confirms and cancels handoffs only through canonical assignment proof", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_session_task_handoff_confirm"),
            fn: async () => {
              const session = await Session.create({})
              const peer = await Session.create({})
              await SessionTask.route({
                sessionID: session.id,
                runID: "run_handoff_old",
                legacy: { title: "Original", body: "Original" },
                actions: [],
              })
              const messageID = await message(session.id)
              const handoff = await SessionTaskHandoff.propose({
                sourceID: session.id,
                messageID,
                runID: "run_handoff",
                actionID: "confirm_handoff",
                title: "Peer task",
                body: "Peer body",
                contextRefs: ["artifact:one"],
              })
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_handoff",
                actionID: "confirm_handoff",
                title: "Peer task",
                plan: "Peer body",
                op: "handoff",
                target: "peer",
              })
              const app = Server.Default()

              const crossed = await app.request(`/session/${peer.id}/task/handoff/${handoff.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff:confirm_handoff", action: "confirm" }),
              })
              expect(crossed.status).toBe(403)

              const invalid = await app.request(`/session/${session.id}/task/handoff/${handoff.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff:wrong", action: "confirm" }),
              })
              expect(invalid.status).toBe(409)

              const confirmed = await app.request(`/session/${session.id}/task/handoff/${handoff.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff:confirm_handoff", action: "confirm" }),
              })
              expect(confirmed.status).toBe(200)
              const body = (await confirmed.json()) as { target_session_id?: string; target_task_id?: string }
              expect(body.target_session_id).toBeString()
              expect(body.target_task_id).toBeString()
              expect((await SessionTaskHandoff.get(handoff.id))?.status).toMatch(/creating|started/)

              const messageID3 = await message(session.id)
              const started = await SessionTaskHandoff.propose({
                sourceID: session.id,
                messageID: messageID3,
                runID: "run_handoff_started",
                actionID: "confirm_handoff_started",
                title: "Started peer",
                body: "Started body",
                contextRefs: [],
              })
              await proposal({
                sessionID: session.id,
                messageID: messageID3,
                runID: "run_handoff_started",
                actionID: "confirm_handoff_started",
                title: "Started peer",
                plan: "Started body",
                op: "handoff",
                target: "peer",
              })
              const proof = await SessionAssignment.apply({
                actionID: "confirm_handoff_started",
                assignment: { op: "handoff", target: "peer" },
                messageID: messageID3,
                plan: "Started body",
                runID: "run_handoff_started",
                sessionID: session.id,
                title: "Started peer",
              })
              if (!proof) throw new Error("handoff proof missing")
              await SessionTaskHandoff.confirm(started.id, { assignmentID: proof.id })
              const late = await app.request(`/session/${session.id}/task/handoff/${started.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff_started:confirm_handoff_started", action: "cancel" }),
              })
              expect(late.status).toBe(409)

              const messageID2 = await message(session.id)
              const cancelled = await SessionTaskHandoff.propose({
                sourceID: session.id,
                messageID: messageID2,
                runID: "run_handoff_cancel",
                actionID: "confirm_handoff_cancel",
                title: "Cancelled peer",
                body: "Cancelled body",
                contextRefs: [],
              })
              await proposal({
                sessionID: session.id,
                messageID: messageID2,
                runID: "run_handoff_cancel",
                actionID: "confirm_handoff_cancel",
                title: "Cancelled peer",
                plan: "Cancelled body",
                op: "handoff",
                target: "peer",
              })
              const res = await app.request(`/session/${session.id}/task/handoff/${cancelled.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff_cancel:confirm_handoff_cancel", action: "cancel" }),
              })
              expect(res.status).toBe(200)
              expect((await SessionTaskHandoff.get(cancelled.id))?.status).toBe("cancelled")
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })
})

function action(id: string, status: "pending" | "completed") {
  const now = Date.now()
  return {
    id,
    title: id,
    operation: "read",
    executor: { type: "tool", target: "read", capabilities: [] },
    input: {},
    depends_on: [],
    status,
    summary: status === "completed" ? `${id} done` : undefined,
    output: status === "completed" ? `${id} output` : undefined,
    tool_call_ids: [],
    duration_ms: status === "completed" ? 1 : undefined,
    time: { started: now, ...(status === "completed" ? { completed: now + 1 } : {}) },
  }
}

async function message(sessionID: SessionID) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "default",
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
    tools: {},
    mode: "",
  } as MessageV2.User)
  return id
}

async function proposal(input: {
  sessionID: SessionID
  messageID: MessageID
  runID: string
  actionID: string
  title: string
  plan: string
  op: "update" | "handoff"
  target: "self" | "peer"
}) {
  const session = await Session.get(input.sessionID)
  const protocol = (session.dsl_context?.protocol ?? {}) as Record<string, unknown>
  const confirmations = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
  await Session.setDslContext({
    sessionID: session.id,
    dsl_context: {
      ...session.dsl_context,
      protocol: {
        ...protocol,
        confirmations: [
          ...confirmations,
          {
            type: "agent.protocol.confirmation",
            version: "1",
            run_id: input.runID,
            action_id: input.actionID,
            action_title: input.title,
            message_id: input.messageID,
            plan: input.plan,
            assignment: { op: input.op, target: input.target },
            assignment_intent: { op: input.op, target: input.target },
            status: "pending",
            updated_at: Date.now(),
          },
        ],
      },
    },
  })
}
