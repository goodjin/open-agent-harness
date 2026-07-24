import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Question } from "../../src/question"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionTask } from "../../src/session/task"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionTaskHandoff } from "../../src/session/task-handoff"
import { SessionTaskConfirmation } from "../../src/session/task-confirmation"
import { SessionTaskRecovery } from "../../src/session/task-recovery"
import { SessionRuns } from "../../src/session/runs"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { resetDatabase } from "../fixture/db"
import { ConflictError, Database, eq } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import {
  AssignmentTable,
  SessionEventOutboxTable,
  SessionTable,
  SessionTaskTable,
  TaskHandoffTable,
  TaskConfirmationTable,
  TaskRevisionTable,
} from "../../src/session/session.sql"
import { tmpdir } from "../fixture/fixture"
import { Storage } from "../../src/storage/storage"
import { AgentProtocol } from "../../src/protocol/schema"

afterEach(resetDatabase)

describe("session task endpoints", () => {
  test("claims one proposal across real Bun processes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const task = await SessionTask.route({
          sessionID: session.id,
          runID: "run_process_old",
          legacy: { title: "Original", body: "Original" },
          actions: [],
        })
        if (task.type !== "execute") throw new Error("task missing")
        const messageID = await message(session.id)
        await proposal({
          sessionID: session.id,
          messageID,
          runID: "run_process",
          actionID: "confirm_process",
          title: "Process",
          plan: "Process body",
          op: "update",
          target: "self",
        })
        const code = [
          'import { spyOn } from "bun:test"',
          'import { Instance } from "./src/project/instance"',
          'import { SessionPrompt } from "./src/session/prompt"',
          'import { SessionTaskConfirmation } from "./src/session/task-confirmation"',
          'const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(async () => { await Bun.sleep(200); return undefined })',
          'const result = await Instance.provide({ directory: process.env.DIR, fn: () => SessionTaskConfirmation.respond({ sessionID: process.env.SESSION, proposalID: "run_process:confirm_process", revisionID: process.env.REVISION, action: "confirm", op: "update" }) })',
          "console.log(JSON.stringify({ result, calls: prompt.mock.calls.length }))",
          "process.exit(0)",
        ].join("\n")
        const children = [0, 1].map(() =>
          Bun.spawn(["bun", "-e", code], {
            cwd: import.meta.dir.replace(/\/test\/server$/, ""),
            env: { ...process.env, DIR: tmp.path, SESSION: session.id, REVISION: task.revision.id },
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        const results = await Promise.all(
          children.map(async (child) => ({
            code: await child.exited,
            out: JSON.parse((await new Response(child.stdout).text()).trim()) as {
              result: { assignment_id?: string }
              calls: number
            },
            err: await new Response(child.stderr).text(),
          })),
        )
        expect(results.map((item) => item.code)).toEqual([0, 0])
        expect(results[0]?.out.result.assignment_id).toBe(results[1]?.out.result.assignment_id)
        expect(results.reduce((sum, item) => sum + item.out.calls, 0)).toBe(1)
        expect(Database.use((db) => db.select().from(AssignmentTable).all())).toHaveLength(1)
        expect(Database.use((db) => db.select().from(SessionEventOutboxTable).all())).toHaveLength(2)
        expect(results.every((item) => !item.err.includes("ERROR"))).toBe(true)
      },
    })
  })

  test("generated OpenAPI describes the task lifecycle without exposing target controls", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()
    const paths = spec.paths as Record<string, Record<string, { operationId?: string; requestBody?: unknown }>>

    expect(paths["/session/{sessionID}/task"]?.get?.operationId).toBe("session.task.current")
    expect(paths["/session/{sessionID}/task/history"]?.get?.operationId).toBe("session.task.history")
    expect(paths["/session/{sessionID}/task/revisions/{version}"]?.get?.operationId).toBe("session.task.revision")
    expect(paths["/session/{sessionID}/task/update/confirm"]?.post?.operationId).toBe("session.task.update.confirm")
    expect(paths["/session/{sessionID}/task/handoff/{handoffID}/confirm"]?.post?.operationId).toBe(
      "session.task.handoff.confirm",
    )
    expect(JSON.stringify(paths["/session/{sessionID}/task/update/confirm"]?.post?.requestBody)).not.toContain(
      "target_session_id",
    )
    expect(
      JSON.stringify(paths["/session/{sessionID}/task/handoff/{handoffID}/confirm"]?.post?.requestBody),
    ).not.toContain("assignment_id")
    const sdk = await Bun.file(new URL("../../../sdk/js/src/v2/gen/sdk.gen.ts", import.meta.url)).text()
    expect(sdk).toContain("get task(): Task")
    expect(sdk).not.toContain("get task2(): Task")
    expect(sdk.indexOf("public current", sdk.indexOf("export class Task"))).toBeGreaterThan(
      sdk.indexOf("export class Task"),
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
            Database.use((db) => {
              db.update(TaskRevisionTable)
                .set({
                  workflow: {
                    actions: [
                      {
                        ...action("old_done", "completed"),
                        run_id: "run_task_old",
                      },
                    ],
                    run_id: "run_task_old",
                    run_ids: ["run_task_old"],
                  },
                  result: "Archived fallback result",
                  result_source: "fallback_summary",
                })
                .where(eq(TaskRevisionTable.id, first.revision.id))
                .run()
              db.insert(TaskHandoffTable)
                .values({
                  id: "handoff_task_reads",
                  source_session_id: session.id,
                  source_task_id: first.task.id,
                  source_message_id: null,
                  target_session_id: null,
                  target_task_id: null,
                  title: "Related handoff",
                  body: "Related handoff body",
                  body_hash: "a".repeat(64),
                  context_refs: [],
                  status: "failed",
                  dedupe_key: "handoff_task_reads",
                  error: "Target creation failed",
                  time_created: 10,
                  time_confirmed: 11,
                  time_completed: 12,
                })
                .run()
            })
            const draft = await SessionTask.draft({
              taskID: first.task.id,
              title: "Revised",
              body: "Revised body",
              reason: "Change scope",
            })
            await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id, stopped: 2 })
            const app = Server.Default()

            const detail = await app.request(`/session/${session.id}`)
            expect(detail.status).toBe(200)
            expect(await detail.json()).toMatchObject({
              id: session.id,
              task: { id: first.task.id, title: "Revised", version: 2, status: "running" },
            })

            const current = await app.request(`/session/${session.id}/task`)
            expect(current.status).toBe(200)
            expect(await current.json()).toMatchObject({
              id: first.task.id,
              session_id: session.id,
              title: "Revised",
              version: 2,
              body: "Revised body",
              handoffs: [
                {
                  id: "handoff_task_reads",
                  title: "Related handoff",
                  status: "failed",
                  source_session_id: session.id,
                  source_task_id: first.task.id,
                  error: "Target creation failed",
                  time: { created: 10, confirmed: 11, completed: 12 },
                },
              ],
            })

            const history = await app.request(`/session/${session.id}/task/history`)
            expect(history.status).toBe(200)
            const items = (await history.json()) as Record<string, unknown>[]
            expect(items).toHaveLength(1)
            expect(items[0]).toMatchObject({
              version: 1,
              status: "archived",
              terminal_status: "completed",
              title: "Original",
              stopped_child_count: 2,
              archive_reason: "Change scope",
              result: { present: true, status: "partial" },
            })
            expect(items[0]).not.toHaveProperty("body")
            expect(items[0]).not.toHaveProperty("workflow")
            expect(typeof items[0]?.result).not.toBe("string")

            const archived = await app.request(`/session/${session.id}/task/revisions/1`)
            expect(archived.status).toBe(200)
            expect(await archived.json()).toMatchObject({
              session_id: session.id,
              version: 1,
              status: "archived",
              terminal_status: "completed",
              stopped_child_count: 2,
              result_status: "partial",
              archive_reason: "Change scope",
              body: "Original body",
              result: "Archived fallback result",
              handoffs: [
                {
                  id: "handoff_task_reads",
                  status: "failed",
                },
              ],
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

  test("opens legacy task routes for zero, one, and multiple runs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_legacy_open"),
          fn: async () => {
            const empty = await Session.create({})
            const single = await Session.create({})
            const multi = await Session.create({})
            const one = legacy("run_route_one", "Route legacy task")
            await Storage.write(["session_protocol_run", single.id, one.run_id], one)
            await SessionRuns.finish({
              sessionID: single.id,
              runID: one.run_id,
              summary: "Route legacy result",
              messageID: "msg_route_legacy",
            })
            await Storage.write(["session_protocol_run", multi.id, "run_route_first"], {
              ...one,
              run_id: "run_route_first",
            })
            await Storage.write(["session_protocol_run", multi.id, "run_route_second"], {
              ...one,
              run_id: "run_route_second",
              title: "   ",
            })
            const app = Server.Default()

            expect((await app.request(`/session/${empty.id}/task`)).status).toBe(404)
            const migrated = await app.request(`/session/${single.id}/task`)
            expect(migrated.status).toBe(200)
            expect(await migrated.json()).toMatchObject({
              version: 1,
              title: "Route legacy task",
              result: "Route legacy result",
              result_source: "protocol",
            })
            expect((await SessionTask.get(single.id))?.task.source_ref).toEqual({
              runID: one.run_id,
              dedupe_key: `legacy-task:${single.id}:${one.run_id}`,
            })
            const proposal = await app.request(`/session/${multi.id}/task`)
            expect(proposal.status).toBe(200)
            const body = await proposal.json()
            expect(body).toMatchObject({
              type: "legacy_multi_run",
              count: 2,
              proposal: {
                status: "pending_confirmation",
                session_id: multi.id,
              },
            })
            expect(body.proposal.runs).toContainEqual(
              expect.objectContaining({ run_id: "run_route_second", title: "Legacy task" }),
            )
            expect(await SessionTask.get(multi.id)).toBeUndefined()
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
                status: "revising",
              })
              expect(replies[0].assignment_id).toBe(replies[1].assignment_id)
              expect(prompt).toHaveBeenCalledTimes(1)
              Database.use((db) =>
                db
                  .update(SessionTaskTable)
                  .set({ status: "blocked" })
                  .where(eq(SessionTaskTable.id, current.task.id))
                  .run(),
              )
              const resume = spyOn(SessionTaskRecovery, "resume").mockResolvedValue(true)
              const resumed = await app.request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_update:confirm_update",
                  revision_id: current.revision.id,
                  action: "confirm",
                }),
              })
              expect(resumed.status).toBe(200)
              expect(await resumed.json()).toMatchObject({ status: "revising" })
              expect(resume).toHaveBeenCalledTimes(1)
              resume.mockRestore()
              Database.use((db) =>
                db
                  .update(SessionTaskTable)
                  .set({ status: "running" })
                  .where(eq(SessionTaskTable.id, current.task.id))
                  .run(),
              )
              expect(
                await SessionAssignment.bySource({
                  sessionID: session.id,
                  runID: "run_update",
                  actionID: "confirm_update",
                }),
              ).toMatchObject({ status: "completed", target: "self" })

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
              const revised = await SessionTask.get(session.id)
              const cancelled = await app.request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_cancel:confirm_cancel",
                  revision_id: revised?.revision.id,
                  action: "cancel",
                }),
              })
              expect(cancelled.status).toBe(200)
              expect(
                await SessionAssignment.bySource({
                  sessionID: session.id,
                  runID: "run_cancel",
                  actionID: "confirm_cancel",
                }),
              ).toBeUndefined()
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("confirms an update from a completed revision and bootstraps an empty successor workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_session_task_terminal_update"),
            fn: async () => {
              const session = await Session.create({})
              const first = await SessionTask.route({
                sessionID: session.id,
                runID: "run_terminal_old",
                legacy: { title: "Completed task", body: "Completed body" },
                actions: [],
              })
              if (first.type !== "execute") throw new Error("task missing")
              Database.use((db) => {
                db.update(TaskRevisionTable)
                  .set({
                    status: "completed",
                    result: "Done",
                    result_source: "protocol",
                    result_status: "completed",
                    terminal_status: "completed",
                    time_completed: Date.now(),
                  })
                  .where(eq(TaskRevisionTable.id, first.revision.id))
                  .run()
                db.update(SessionTaskTable)
                  .set({ status: "completed" })
                  .where(eq(SessionTaskTable.id, first.task.id))
                  .run()
              })
              const messageID = await message(session.id)
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_terminal_stale",
                actionID: "confirm_terminal_stale",
                title: "Stale update",
                plan: "Stale body",
                op: "update",
                target: "self",
              })
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_terminal_update",
                actionID: "confirm_terminal_update",
                title: "Continued task",
                plan: "Continued body",
                op: "update",
                target: "self",
              })

              const result = await SessionTaskConfirmation.respond({
                sessionID: session.id,
                proposalID: "run_terminal_update:confirm_terminal_update",
                revisionID: first.revision.id,
                action: "confirm",
                op: "update",
              })
              expect(result).toMatchObject({ status: "revising" })
              const saved = await Session.get(session.id)
              const protocol = saved.dsl_context?.protocol as
                | { confirmations?: { action_id?: string; status?: string }[] }
                | undefined
              expect(protocol?.confirmations).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ action_id: "confirm_terminal_stale", status: "superseded" }),
                  expect.objectContaining({ action_id: "confirm_terminal_update", status: "confirmed" }),
                ]),
              )
              await SessionTaskRecovery.resume(session.id)

              const current = await SessionTask.get(session.id)
              expect(current).toMatchObject({
                task: { status: "running" },
                revision: {
                  version: 2,
                  status: "active",
                  title: "Continued task",
                  body: "Continued body",
                  workflow: { actions: [] },
                },
              })
              expect(
                Database.use((db) =>
                  db.select().from(TaskRevisionTable).where(eq(TaskRevisionTable.id, first.revision.id)).get(),
                ),
              ).toMatchObject({ status: "archived", terminal_status: "completed" })
              expect(
                Database.use((db) =>
                  db
                    .select()
                    .from(SessionEventOutboxTable)
                    .where(eq(SessionEventOutboxTable.dedupe_key, `task_revision_bootstrap:${current?.revision.id}`))
                    .get(),
                ),
              ).toMatchObject({ status: "delivered" })
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("persists owner-side task confirmation failures instead of abandoning claimed rows", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_confirmation_failure"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_failure_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_failure",
              actionID: "confirm_failure",
              title: "Blocked update",
              plan: "Blocked body",
              op: "update",
              target: "self",
            })
            Database.use((db) =>
              db
                .update(SessionTaskTable)
                .set({ status: "blocked" })
                .where(eq(SessionTaskTable.id, task.task.id))
                .run(),
            )

            await expect(
              SessionTaskConfirmation.respond({
                sessionID: session.id,
                proposalID: "run_failure:confirm_failure",
                revisionID: task.revision.id,
                action: "confirm",
                op: "update",
              }),
            ).rejects.toBeInstanceOf(ConflictError)
            expect(
              Database.use((db) =>
                db
                  .select()
                  .from(TaskConfirmationTable)
                  .where(eq(TaskConfirmationTable.proposal_id, "run_failure:confirm_failure"))
                  .get(),
              ),
            ).toMatchObject({
              status: "failed",
              lease_until: 0,
              error: "session_task_update_in_progress",
            })
          },
        }),
    })
  })

  test("publishes the task proposal decision before continuation completes", async () => {
    await using tmp = await tmpdir({ git: true })
    let enter = () => {}
    let release = () => {}
    const entered = new Promise<void>((resolve) => (enter = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      enter()
      await blocked
      return undefined
    }) as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_session_task_decision_first"),
            fn: async () => {
              const session = await Session.create({})
              const task = await SessionTask.route({
                sessionID: session.id,
                runID: "run_decision_old",
                legacy: { title: "Original", body: "Original" },
                actions: [],
              })
              if (task.type !== "execute") throw new Error("task missing")
              const messageID = await message(session.id)
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_decision",
                actionID: "confirm_decision",
                title: "Revised",
                plan: "Revised body",
                op: "update",
                target: "self",
              })

              const response = SessionTaskConfirmation.respond({
                sessionID: session.id,
                proposalID: "run_decision:confirm_decision",
                revisionID: task.revision.id,
                action: "confirm",
                op: "update",
              })
              await entered
              const current = await Session.get(session.id)
              const protocol = current.dsl_context?.protocol as
                | { confirmations?: { status?: string; response?: string }[] }
                | undefined
              expect(protocol?.confirmations?.[0]).toMatchObject({ status: "confirmed", response: "confirm" })
              expect(
                Database.use((db) =>
                  db.select().from(TaskConfirmationTable).where(eq(TaskConfirmationTable.session_id, session.id)).get(),
                )?.status,
              ).toBe("continuation_pending")
              release()
              await response
            },
          }),
      })
    } finally {
      release()
      prompt.mockRestore()
    }
  })

  test("rejects a revision activated between route check and confirmation claim", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_revision_barrier"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_barrier_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_barrier",
              actionID: "confirm_barrier",
              title: "Barrier",
              plan: "Barrier body",
              op: "update",
              target: "self",
            })
            const next = await SessionTask.draft({ taskID: task.task.id, title: "Concurrent", body: "Concurrent" })
            const original = SessionTaskConfirmation.respond
            const gate = spyOn(SessionTaskConfirmation, "respond").mockImplementation(async (input) => {
              await SessionTask.activate({ taskID: task.task.id, revisionID: next.id })
              return original(input)
            })
            try {
              const res = await Server.Default().request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  proposal_id: "run_barrier:confirm_barrier",
                  revision_id: task.revision.id,
                  action: "confirm",
                }),
              })
              expect(res.status).toBe(409)
              expect(
                await SessionAssignment.bySource({
                  sessionID: session.id,
                  runID: "run_barrier",
                  actionID: "confirm_barrier",
                }),
              ).toBeUndefined()
              expect(prompt).not.toHaveBeenCalled()
              const ctx = (await Session.get(session.id)).dsl_context?.protocol as {
                confirmations?: { status?: string }[]
              }
              expect(ctx.confirmations?.[0]?.status).toBe("pending")
            } finally {
              gate.mockRestore()
              prompt.mockRestore()
            }
          },
        }),
    })
  })

  test("fences an expired confirmation owner behind a new generation", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_confirmation_fence"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_fence_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_fence",
              actionID: "confirm_fence",
              title: "Fence",
              plan: "Fence body",
              op: "update",
              target: "self",
            })
            const original = SessionAssignment.apply
            let unblock = () => {}
            let enter = () => {}
            const blocked = new Promise<void>((resolve) => (unblock = resolve))
            const entered = new Promise<void>((resolve) => (enter = resolve))
            let count = 0
            const apply = spyOn(SessionAssignment, "apply").mockImplementation(async (input) => {
              count++
              if (count === 1) {
                enter()
                await blocked
              }
              return original(input)
            })
            const body = JSON.stringify({
              proposal_id: "run_fence:confirm_fence",
              revision_id: task.revision.id,
              action: "confirm",
            })
            try {
              const first = Server.Default().request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              })
              await entered
              Database.use((db) =>
                db
                  .update(TaskConfirmationTable)
                  .set({ lease_until: 0 })
                  .where(eq(TaskConfirmationTable.proposal_id, "run_fence:confirm_fence"))
                  .run(),
              )
              const second = await Server.Default().request(`/session/${session.id}/task/update/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              })
              unblock()
              expect(second.status).toBe(200)
              expect((await first).status).toBe(409)
              expect(prompt).toHaveBeenCalledTimes(1)
              expect(Database.use((db) => db.select().from(AssignmentTable).all())).toHaveLength(1)
              expect(Database.use((db) => db.select().from(SessionEventOutboxTable).all())).toHaveLength(2)
            } finally {
              unblock()
              apply.mockRestore()
              prompt.mockRestore()
            }
          },
        }),
    })
  })

  test("keeps a healthy owner across assignment, handoff, and live reply barriers", async () => {
    const prior = process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS
    process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS = "300"
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_session_task_confirmation_heartbeat"),
            fn: async () => {
              const session = await Session.create({})
              const task = await SessionTask.route({
                sessionID: session.id,
                runID: "run_heartbeat_old",
                legacy: { title: "Original", body: "Original" },
                actions: [],
              })
              if (task.type !== "execute") throw new Error("task missing")
              const app = Server.Default()

              const run = async (input: {
                id: string
                op: "update" | "handoff"
                block: (enter: () => void, wait: Promise<void>) => () => void
                handoffID?: string
              }) => {
                const current = await SessionTask.get(session.id)
                const body = JSON.stringify({
                  proposal_id: `run_${input.id}:confirm_${input.id}`,
                  revision_id: input.op === "update" ? current?.revision.id : undefined,
                  action: "confirm",
                })
                let enter = () => {}
                let release = () => {}
                const entered = new Promise<void>((resolve) => (enter = resolve))
                const blocked = new Promise<void>((resolve) => (release = resolve))
                const restore = input.block(enter, blocked)
                const path =
                  input.op === "update"
                    ? `/session/${session.id}/task/update/confirm`
                    : `/session/${session.id}/task/handoff/${input.handoffID}/confirm`
                try {
                  const first = app.request(path, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                  })
                  await entered
                  Database.use((db) =>
                    db
                      .update(TaskConfirmationTable)
                      .set({ lease_until: Date.now() + 300 })
                      .where(eq(TaskConfirmationTable.proposal_id, `run_${input.id}:confirm_${input.id}`))
                      .run(),
                  )
                  await Bun.sleep(650)
                  let done = false
                  const second = Promise.resolve(
                    app.request(path, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body,
                    }),
                  ).then((value) => {
                    done = true
                    return value
                  })
                  await Bun.sleep(100)
                  expect(done).toBe(false)
                  release()
                  expect((await first).status).toBe(200)
                  expect((await second).status).toBe(200)
                } finally {
                  release()
                  restore()
                }
              }

              const messageID = await message(session.id)
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_heartbeat_assignment",
                actionID: "confirm_heartbeat_assignment",
                title: "Assignment heartbeat",
                plan: "Assignment heartbeat body",
                op: "update",
                target: "self",
              })
              let assignments = 0
              await run({
                id: "heartbeat_assignment",
                op: "update",
                block: (enter, wait) => {
                  const original = SessionAssignment.apply
                  const spy = spyOn(SessionAssignment, "apply").mockImplementation(async (value) => {
                    assignments++
                    enter()
                    await wait
                    return original(value)
                  })
                  return () => spy.mockRestore()
                },
              })
              expect(assignments).toBe(1)

              const messageID2 = await message(session.id)
              const handoff = await SessionTaskHandoff.propose({
                sourceID: session.id,
                messageID: messageID2,
                runID: "run_heartbeat_handoff",
                actionID: "confirm_heartbeat_handoff",
                title: "Handoff heartbeat",
                body: "Handoff heartbeat body",
                contextRefs: [],
              })
              await proposal({
                sessionID: session.id,
                messageID: messageID2,
                runID: "run_heartbeat_handoff",
                actionID: "confirm_heartbeat_handoff",
                title: "Handoff heartbeat",
                plan: "Handoff heartbeat body",
                op: "handoff",
                target: "peer",
              })
              let handoffs = 0
              await run({
                id: "heartbeat_handoff",
                op: "handoff",
                handoffID: handoff.id,
                block: (enter, wait) => {
                  const original = SessionTaskHandoff.confirm
                  const spy = spyOn(SessionTaskHandoff, "confirm").mockImplementation(async (id, value) => {
                    handoffs++
                    enter()
                    await wait
                    return original(id, value)
                  })
                  return () => spy.mockRestore()
                },
              })
              expect(handoffs).toBe(1)

              const messageID3 = await message(session.id)
              await proposal({
                sessionID: session.id,
                messageID: messageID3,
                runID: "run_heartbeat_reply",
                actionID: "confirm_heartbeat_reply",
                title: "Reply heartbeat",
                plan: "Reply heartbeat body",
                op: "update",
                target: "self",
              })
              const asked = Question.askReply({
                sessionID: session.id,
                questions: [
                  { question: "Confirm?", header: "Confirm", options: [{ label: "Confirm", description: "Confirm" }] },
                ],
                tool: { messageID: messageID3, callID: "call_confirm_heartbeat_reply" },
              })
              while (!(await Question.list()).length) await Bun.sleep(1)
              let replies = 0
              await run({
                id: "heartbeat_reply",
                op: "update",
                block: (enter, wait) => {
                  const original = Question.reply
                  const spy = spyOn(Question, "reply").mockImplementation(async (value) => {
                    replies++
                    enter()
                    await wait
                    return original(value)
                  })
                  return () => spy.mockRestore()
                },
              })
              expect(replies).toBe(1)
              expect((await asked).response).toBe("confirm")
              expect(Database.use((db) => db.select().from(AssignmentTable).all())).toHaveLength(3)
              const outbox = Database.use((db) => db.select().from(SessionEventOutboxTable).all()).filter(
                (row) => row.kind === "task_confirmation",
              )
              expect(outbox).toHaveLength(3)
              expect(
                outbox
                  .map((row) => (typeof row.payload === "object" && row.payload ? row.payload.mode : undefined))
                  .sort(),
              ).toEqual(["prompt", "prompt", "prompt"])
              expect(prompt).toHaveBeenCalledTimes(2)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
      if (prior === undefined) delete process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS
      if (prior !== undefined) process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS = prior
    }
  })

  test("contains heartbeat renewal exceptions and clears the timer", async () => {
    const prior = process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS
    process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS = "60"
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    const use = Database.use
    let fail = false
    let throws = 0
    const db = spyOn(Database, "use").mockImplementation(((fn) => {
      if (fail) {
        throws++
        throw new Error("heartbeat database unavailable")
      }
      return use(fn)
    }) as typeof Database.use)
    const logger = Log.create({ service: "session.task-confirmation" })
    const error = spyOn(logger, "error").mockImplementation(() => {})
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    const unhandled: unknown[] = []
    const listener = (err: unknown) => unhandled.push(err)
    process.on("unhandledRejection", listener)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_session_task_heartbeat_error"),
            fn: async () => {
              const session = await Session.create({})
              const task = await SessionTask.route({
                sessionID: session.id,
                runID: "run_heartbeat_error_old",
                legacy: { title: "Original", body: "Original" },
                actions: [],
              })
              if (task.type !== "execute") throw new Error("task missing")
              const messageID = await message(session.id)
              await proposal({
                sessionID: session.id,
                messageID,
                runID: "run_heartbeat_error",
                actionID: "confirm_heartbeat_error",
                title: "Heartbeat error",
                plan: "Heartbeat error body",
                op: "update",
                target: "self",
              })
              let enter = () => {}
              let release = () => {}
              const entered = new Promise<void>((resolve) => (enter = resolve))
              const blocked = new Promise<void>((resolve) => (release = resolve))
              const original = SessionAssignment.apply
              const assignment = spyOn(SessionAssignment, "apply").mockImplementation(async (input) => {
                enter()
                await blocked
                return original(input)
              })
              try {
                const response = SessionTaskConfirmation.respond({
                  sessionID: session.id,
                  proposalID: "run_heartbeat_error:confirm_heartbeat_error",
                  revisionID: task.revision.id,
                  action: "confirm",
                  op: "update",
                })
                await entered
                fail = true
                await Bun.sleep(140)
                expect(throws).toBe(1)
                expect(error).toHaveBeenCalledTimes(1)
                expect(warn).toHaveBeenCalledTimes(0)
                fail = false
                release()
                await expect(response).rejects.toBeInstanceOf(ConflictError)
                const count = throws
                await Bun.sleep(80)
                expect(throws).toBe(count)
                expect(unhandled).toHaveLength(0)
              } finally {
                fail = false
                release()
                assignment.mockRestore()
              }
            },
          }),
      })
    } finally {
      process.off("unhandledRejection", listener)
      error.mockRestore()
      warn.mockRestore()
      db.mockRestore()
      prompt.mockRestore()
      if (prior === undefined) delete process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS
      if (prior !== undefined) process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS = prior
    }
  })

  test("bounds recovery concurrency and keeps owner lookup read-only", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_scan_limit"),
          fn: async () => {
            const session = await Session.create({})
            const now = Date.now()
            Database.use((db) =>
              db
                .insert(TaskConfirmationTable)
                .values(
                  Array.from({ length: 9 }, (_, index) => ({
                    id: `confirmation_scan_${index}`,
                    session_id: session.id,
                    proposal_id: `run_scan_${index}:confirm_scan_${index}`,
                    operation: "update" as const,
                    decision: "confirm" as const,
                    status: "failed" as const,
                    message_id: MessageID.ascending(),
                    lease_until: 0,
                    time_created: now,
                    time_updated: now,
                  })),
                )
                .run(),
            )
            let active = 0
            let peak = 0
            let calls = 0
            const results = await SessionTaskConfirmation.scan(async () => {
              const index = calls++
              active++
              peak = Math.max(peak, active)
              await Bun.sleep(20)
              active--
              if (index === 5) throw new Error("isolated recovery failure")
              return {} as never
            })
            expect(peak).toBe(4)
            expect(results).toHaveLength(9)
            expect(results.filter(Boolean)).toHaveLength(8)
            expect(results.filter((item) => !item)).toHaveLength(1)
          },
        }),
    })
    const source = await Bun.file(new URL("../../src/session/task-confirmation.ts", import.meta.url)).text()
    const owner = source.slice(source.indexOf("function owner("), source.indexOf("async function safe"))
    expect(owner).toContain("Database.use")
    expect(owner).not.toContain("Database.transaction")
    expect(owner).not.toContain('behavior: "immediate"')
  })

  test("keeps a reclaimed live reply on its durable prompt carrier", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_reply_mode"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_reply_mode_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_reply_mode",
              actionID: "confirm_reply_mode",
              title: "Reply mode",
              plan: "Reply mode body",
              op: "update",
              target: "self",
            })
            const asked = Question.askReply({
              sessionID: session.id,
              questions: [
                {
                  question: "Confirm?",
                  header: "Confirm",
                  options: [{ label: "Confirm", description: "Confirm" }],
                },
              ],
              tool: { messageID, callID: "call_confirm_reply_mode" },
            })
            while (!(await Question.list()).length) await Bun.sleep(1)
            const pending = (await Question.list())[0]
            if (!pending) throw new Error("question missing")
            const original = Question.reply
            let enter = () => {}
            let release = () => {}
            const entered = new Promise<void>((resolve) => (enter = resolve))
            const blocked = new Promise<void>((resolve) => (release = resolve))
            let replies = 0
            const reply = spyOn(Question, "reply").mockImplementation(async (value) => {
              replies++
              if (replies === 1) {
                enter()
                await blocked
                return original(value)
              }
              return false
            })
            const body = JSON.stringify({
              proposal_id: "run_reply_mode:confirm_reply_mode",
              revision_id: task.revision.id,
              action: "confirm",
            })
            const path = `/session/${session.id}/task/update/confirm`
            try {
              const first = Server.Default().request(path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              })
              await entered
              Database.transaction(
                (db) => {
                  db.update(TaskConfirmationTable)
                    .set({ lease_until: 0 })
                    .where(eq(TaskConfirmationTable.proposal_id, "run_reply_mode:confirm_reply_mode"))
                    .run()
                  const row = db
                    .select()
                    .from(SessionEventOutboxTable)
                    .where(eq(SessionEventOutboxTable.kind, "task_confirmation"))
                    .get()
                  if (!row || typeof row.payload !== "object" || !row.payload) throw new Error("outbox missing")
                  db.update(SessionEventOutboxTable)
                    .set({ payload: { ...row.payload, lease_until: 0 } })
                    .where(eq(SessionEventOutboxTable.id, row.id))
                    .run()
                },
                { behavior: "immediate" },
              )
              const second = await Server.Default().request(path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              })
              release()
              expect(second.status).toBe(200)
              expect((await first).status).toBe(409)
              expect(replies).toBe(2)
              expect(prompt).toHaveBeenCalledTimes(1)
              const outbox = Database.use((db) =>
                db
                  .select()
                  .from(SessionEventOutboxTable)
                  .where(eq(SessionEventOutboxTable.kind, "task_confirmation"))
                  .get(),
              )
              expect(outbox?.status).toBe("delivered")
              expect(outbox?.payload).toMatchObject({ mode: "prompt", generation: 2 })
            } finally {
              release()
              await Question.reject(pending.id)
              await asked.catch(() => undefined)
              reply.mockRestore()
              prompt.mockRestore()
            }
          },
        }),
    })
  })

  test("routes live and restored Task questions through one durable confirmation service", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompts: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      prompts.push(input)
      return undefined as never
    }) as unknown as typeof SessionPrompt.prompt)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_question_route"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_question_route_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_question_live",
              actionID: "confirm_question_live",
              title: "Live question",
              plan: "Live question body",
              op: "update",
              target: "self",
            })
            const asked = Question.askReply({
              sessionID: session.id,
              questions: [{ question: "Confirm?", header: "Confirm", options: [] }],
              tool: { messageID, callID: "call_confirm_question_live" },
            })
            while (!(await Question.list()).length) await Bun.sleep(1)
            const live = (await Question.list())[0]
            if (!live) throw new Error("live question missing")
            const app = Server.Default()
            const first = await app.request(`/question/${live.id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
            })
            expect(first.status).toBe(200)
            expect((await asked).rerouted).toBe(true)

            const messageID2 = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID: messageID2,
              runID: "run_question_restored",
              actionID: "confirm_question_restored",
              title: "Restored question",
              plan: "Restored question body",
              op: "update",
              target: "self",
            })
            const listed = (await (await app.request("/question")).json()) as { id: string }[]
            const second = await app.request(`/question/${listed[0]?.id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
            })
            expect(second.status).toBe(200)
            expect(await SessionTaskConfirmation.scan()).toEqual([])
            const replay = await app.request(`/question/${listed[0]?.id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
            })
            expect(replay.status).toBe(409)
            const rows = Database.use((db) => db.select().from(TaskConfirmationTable).all())
            expect(rows).toHaveLength(2)
            expect(rows.every((row) => row.status === "completed")).toBe(true)
            const outbox = Database.use((db) => db.select().from(SessionEventOutboxTable).all()).filter(
              (row) => row.kind === "task_confirmation",
            )
            expect(outbox).toHaveLength(2)
            expect(outbox.every((row) => row.status === "delivered")).toBe(true)
            expect(prompts).toHaveLength(2)
            expect(prompts.every((input) => input.metadata?.source === "task_revision_bootstrap")).toBe(true)

            const messageID3 = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID: messageID3,
              runID: "run_question_reject",
              actionID: "confirm_question_reject",
              title: "Rejected question",
              plan: "Rejected question body",
              op: "update",
              target: "self",
            })
            const cancellable = (await (await app.request("/question")).json()) as { id: string }[]
            const cancelled = await app.request(`/question/${cancellable[0]?.id}/reject`, { method: "POST" })
            expect(cancelled.status).toBe(200)
            expect(Database.use((db) => db.select().from(TaskConfirmationTable).all())).toHaveLength(3)
            expect(prompts).toHaveLength(2)

            const messageID4 = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID: messageID4,
              runID: "run_question_tampered",
              actionID: "confirm_question_tampered",
              title: "Tampered question",
              plan: "Tampered question body",
              op: "handoff",
              target: "peer",
            })
            const pending = (await (await app.request("/question")).json()) as { id: string }[]
            const rejected = await app.request(`/question/${pending[0]?.id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
            })
            expect(rejected.status).toBe(409)
            expect(Database.use((db) => db.select().from(TaskConfirmationTable).all())).toHaveLength(3)
          },
        }),
    })
    prompt.mockRestore()
  })

  test("rejects task proposal question replies without an explicit decision", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_question_decision"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_question_decision_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_question_decision",
              actionID: "confirm_question_decision",
              title: "Decision",
              plan: "Decision body",
              op: "update",
              target: "self",
            })
            const asked = Question.askReply({
              sessionID: session.id,
              questions: [{ question: "Confirm?", header: "Confirm", options: [] }],
              tool: { messageID, callID: "call_confirm_question_decision" },
            })
            while (!(await Question.list()).length) await Bun.sleep(1)
            const pending = (await Question.list())[0]
            if (!pending) throw new Error("question missing")
            try {
              const empty = await Server.Default().request(`/question/${pending.id}/reply`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ answers: [] }),
              })
              expect(empty.status).toBe(409)
              expect(Database.use((db) => db.select().from(TaskConfirmationTable).all())).toHaveLength(0)
              expect(Database.use((db) => db.select().from(AssignmentTable).all())).toHaveLength(0)
              const current = await Session.get(session.id)
              const protocol = current.dsl_context?.protocol as { confirmations?: { status?: string }[] } | undefined
              expect(protocol?.confirmations?.[0]?.status).toBe("pending")
            } finally {
              await Question.reject(pending.id)
              await asked.catch(() => undefined)
            }
          },
        }),
    })
  })

  test("fails closed for live Task questions with missing or duplicate protocol locators", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_live_locator"),
          fn: async () => {
            const cases = (["update", "handoff"] as const).flatMap((op) =>
              (["missing", "duplicate"] as const).flatMap((mode) =>
                (["reply", "reject"] as const).map((route) => ({ id: `${op}_${mode}_${route}`, op, mode, route })),
              ),
            )
            const app = Server.Default()
            for (const item of cases) {
              const session = await Session.create({})
              await SessionTask.route({
                sessionID: session.id,
                runID: `run_${item.id}_old`,
                legacy: { title: "Original", body: "Original" },
                actions: [],
              })
              const messageID = await assistant(session.id)
              const runID = `run_${item.id}`
              const actionID = `confirm_${item.id}`
              const handoff =
                item.op === "handoff"
                  ? await SessionTaskHandoff.propose({
                      sourceID: session.id,
                      messageID,
                      runID,
                      actionID,
                      title: "Peer task",
                      body: "Peer body",
                      contextRefs: [],
                    })
                  : undefined
              await proposal({
                sessionID: session.id,
                messageID,
                runID,
                actionID,
                title: "Live task",
                plan: "Live task body",
                op: item.op,
                target: item.op === "update" ? "self" : "peer",
              })
              await evidence({
                sessionID: session.id,
                messageID,
                actionID,
                kind: "confirm",
                assignment: { op: item.op, target: item.op === "update" ? "self" : "peer" },
              })
              await locate(session.id, runID, actionID, item.mode)
              const asked = Question.askReply({
                sessionID: session.id,
                questions: [{ question: "Confirm?", header: "Confirm", options: [] }],
                tool: { messageID, callID: `call_${actionID}` },
              })
              let settled = false
              void asked.then(
                () => (settled = true),
                () => (settled = true),
              )
              while (!(await Question.list()).some((question) => question.sessionID === session.id)) await Bun.sleep(1)
              const pending = (await Question.list()).find((question) => question.sessionID === session.id)
              if (!pending) throw new Error("question missing")
              const sessions = Database.use((db) => db.select().from(SessionTable).all()).length
              const tasks = Database.use((db) => db.select().from(SessionTaskTable).all()).length
              const calls = prompt.mock.calls.length
              const res = await app.request(`/question/${pending.id}/${item.route}`, {
                method: "POST",
                ...(item.route === "reply"
                  ? {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
                    }
                  : {}),
              })
              expect(res.status).toBe(409)
              expect((await Question.list()).some((question) => question.id === pending.id)).toBe(true)
              expect(settled).toBe(false)
              expect(Database.use((db) => db.select().from(TaskConfirmationTable).all())).toHaveLength(0)
              expect(Database.use((db) => db.select().from(AssignmentTable).all())).toHaveLength(0)
              expect(Database.use((db) => db.select().from(SessionEventOutboxTable).all())).toHaveLength(0)
              expect(prompt.mock.calls.length).toBe(calls)
              expect(Database.use((db) => db.select().from(SessionTable).all())).toHaveLength(sessions)
              expect(Database.use((db) => db.select().from(SessionTaskTable).all())).toHaveLength(tasks)
              if (handoff) expect(await SessionTaskHandoff.get(handoff.id)).toMatchObject({ status: "proposed" })
              await Question.reject(pending.id)
              await asked.catch(() => undefined)
            }

            const session = await Session.create({})
            const messageID = await assistant(session.id)
            await evidence({ sessionID: session.id, messageID, actionID: "input_live", kind: "input" })
            const asked = Question.askReply({
              sessionID: session.id,
              questions: [{ question: "Choose", header: "Choose", options: [{ label: "A", description: "A" }] }],
              tool: { messageID, callID: "call_input_live" },
            })
            while (!(await Question.list()).some((question) => question.sessionID === session.id)) await Bun.sleep(1)
            const pending = (await Question.list()).find((question) => question.sessionID === session.id)
            if (!pending) throw new Error("input question missing")
            const calls = prompt.mock.calls.length
            const res = await app.request(`/question/${pending.id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["A"]] }),
            })
            expect(res.status).toBe(200)
            expect((await asked).answers).toEqual([["A"]])
            expect(prompt.mock.calls.length).toBe(calls)
          },
        }),
    })
    prompt.mockRestore()
  })

  test("uses only completed assistant protocol evidence for live Task classification", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_live_evidence"),
          fn: async () => {
            const app = Server.Default()
            for (const kind of ["user", "pending"] as const) {
              const session = await Session.create({})
              const messageID = kind === "user" ? await message(session.id) : await assistant(session.id)
              await evidence({
                sessionID: session.id,
                messageID,
                actionID: `guard_${kind}`,
                kind: "confirm",
                assignment: { op: "update", target: "self" },
                status: kind === "pending" ? "pending" : "completed",
              })
              const asked = Question.askReply({
                sessionID: session.id,
                questions: [{ question: "Continue?", header: "Continue", options: [] }],
                tool: { messageID, callID: `call_guard_${kind}` },
              })
              while (!(await Question.list()).some((item) => item.sessionID === session.id)) await Bun.sleep(1)
              const pending = (await Question.list()).find((item) => item.sessionID === session.id)
              if (!pending) throw new Error("guard question missing")
              const res = await app.request(`/question/${pending.id}/reply`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ answers: [["Continue"]] }),
              })
              expect(res.status).toBe(200)
              expect((await asked).answers).toEqual([["Continue"]])
            }

            const session = await Session.create({})
            const messageID = await assistant(session.id)
            await evidence({
              sessionID: session.id,
              messageID,
              actionID: "guard_error",
              kind: "confirm",
              assignment: { op: "update", target: "self" },
            })
            const asked = Question.askReply({
              sessionID: session.id,
              questions: [{ question: "Confirm?", header: "Confirm", options: [] }],
              tool: { messageID, callID: "call_guard_error" },
            })
            while (!(await Question.list()).some((item) => item.sessionID === session.id)) await Bun.sleep(1)
            const pending = (await Question.list()).find((item) => item.sessionID === session.id)
            if (!pending) throw new Error("error question missing")
            const get = MessageV2.get
            const read = spyOn(MessageV2, "get").mockImplementation((async (input: Parameters<typeof get>[0]) => {
              if (input.sessionID === session.id && input.messageID === messageID)
                throw new Error("carrier read failed")
              return get(input)
            }) as never)
            try {
              const res = await app.request(`/question/${pending.id}/reply`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ answers: [["Confirm"]] }),
              })
              expect(res.status).toBe(500)
              expect((await Question.list()).some((item) => item.id === pending.id)).toBe(true)
            } finally {
              read.mockRestore()
              await Question.reject(pending.id)
              await asked.catch(() => undefined)
            }
          },
        }),
    })
  })

  test("imports only canonical legacy terminal confirmations without continuing", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_task_legacy_terminal"),
          fn: async () => {
            const session = await Session.create({})
            const task = await SessionTask.route({
              sessionID: session.id,
              runID: "run_legacy_old",
              legacy: { title: "Original", body: "Original" },
              actions: [],
            })
            if (task.type !== "execute") throw new Error("task missing")
            const messageID = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID,
              runID: "run_legacy_done",
              actionID: "confirm_legacy_done",
              title: "Legacy done",
              plan: "Legacy done body",
              op: "update",
              target: "self",
            })
            const assignment = await SessionAssignment.apply({
              actionID: "confirm_legacy_done",
              assignment: { op: "update", target: "self" },
              messageID,
              plan: "Legacy done body",
              runID: "run_legacy_done",
              sessionID: session.id,
              title: "Legacy done",
            })
            if (!assignment) throw new Error("assignment missing")
            await rewrite(session.id, "run_legacy_done", "confirm_legacy_done", {
              status: "confirmed",
              response: "confirm",
              assignment: {
                id: assignment.id,
                session_id: assignment.session_id,
                status: assignment.status,
                content_ref: assignment.content_ref,
                content_version: assignment.content_version,
              },
            })
            const input = {
              sessionID: session.id,
              proposalID: "run_legacy_done:confirm_legacy_done",
              revisionID: task.revision.id,
              action: "confirm" as const,
              op: "update" as const,
            }
            const calls = prompt.mock.calls.length
            const first = await SessionTaskConfirmation.respond(input)
            const second = await SessionTaskConfirmation.respond(input)
            expect(second).toEqual(first)
            expect(first.assignment_id).toBe(assignment.id)
            const row = Database.use((db) => db.select().from(TaskConfirmationTable).get())
            expect(row).toMatchObject({ status: "completed", lease_until: 0, result: first })
            expect(Database.use((db) => db.select().from(SessionEventOutboxTable).all())).toHaveLength(0)
            expect(prompt.mock.calls.length).toBe(calls)

            const messageID2 = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID: messageID2,
              runID: "run_legacy_bad",
              actionID: "confirm_legacy_bad",
              title: "Legacy bad",
              plan: "Legacy bad body",
              op: "update",
              target: "self",
            })
            await rewrite(session.id, "run_legacy_bad", "confirm_legacy_bad", {
              status: "confirmed",
              response: "confirm",
            })
            await expect(
              SessionTaskConfirmation.respond({
                sessionID: session.id,
                proposalID: "run_legacy_bad:confirm_legacy_bad",
                revisionID: task.revision.id,
                action: "confirm",
                op: "update",
              }),
            ).rejects.toThrow()
            expect(Database.use((db) => db.select().from(TaskConfirmationTable).all())).toHaveLength(1)

            const messageID3 = await message(session.id)
            await proposal({
              sessionID: session.id,
              messageID: messageID3,
              runID: "run_legacy_cancel",
              actionID: "confirm_legacy_cancel",
              title: "Legacy cancel",
              plan: "Legacy cancel body",
              op: "update",
              target: "self",
            })
            await rewrite(session.id, "run_legacy_cancel", "confirm_legacy_cancel", {
              status: "cancelled",
              response: "cancel",
            })
            const cancelled = await SessionTaskConfirmation.respond({
              sessionID: session.id,
              proposalID: "run_legacy_cancel:confirm_legacy_cancel",
              revisionID: task.revision.id,
              action: "cancel",
              op: "update",
            })
            expect(cancelled).toMatchObject({
              action: "cancel",
              proposal_id: "run_legacy_cancel:confirm_legacy_cancel",
            })
            expect(
              Database.use((db) => db.select().from(TaskConfirmationTable).all()).map((item) => item.status),
            ).toEqual(["completed", "cancelled"])
            expect(await SessionTaskConfirmation.scan()).toEqual([])

            const messageID4 = await message(session.id)
            const firstHandoff = await SessionTaskHandoff.propose({
              sourceID: session.id,
              messageID: messageID4,
              runID: "run_legacy_handoff",
              actionID: "confirm_legacy_handoff",
              title: "Legacy handoff",
              body: "Legacy handoff body",
              contextRefs: [],
            })
            const otherHandoff = await SessionTaskHandoff.propose({
              sourceID: session.id,
              messageID: messageID4,
              runID: "run_legacy_other",
              actionID: "confirm_legacy_other",
              title: "Legacy handoff",
              body: "Legacy handoff body",
              contextRefs: [],
            })
            await proposal({
              sessionID: session.id,
              messageID: messageID4,
              runID: "run_legacy_handoff",
              actionID: "confirm_legacy_handoff",
              title: "Legacy handoff",
              plan: "Legacy handoff body",
              op: "handoff",
              target: "peer",
            })
            const firstProof = await SessionAssignment.apply({
              actionID: "confirm_legacy_handoff",
              assignment: { op: "handoff", target: "peer" },
              messageID: messageID4,
              plan: "Legacy handoff body",
              runID: "run_legacy_handoff",
              sessionID: session.id,
              title: "Legacy handoff",
            })
            const otherProof = await SessionAssignment.apply({
              actionID: "confirm_legacy_other",
              assignment: { op: "handoff", target: "peer" },
              messageID: messageID4,
              plan: "Legacy handoff body",
              runID: "run_legacy_other",
              sessionID: session.id,
              title: "Legacy handoff",
            })
            if (!firstProof || !otherProof) throw new Error("handoff assignment missing")
            await SessionTaskHandoff.confirm(otherHandoff.id, { assignmentID: otherProof.id })
            await rewrite(session.id, "run_legacy_handoff", "confirm_legacy_handoff", {
              status: "confirmed",
              response: "confirm",
              assignment: { id: firstProof.id },
            })
            await expect(
              SessionTaskConfirmation.respond({
                sessionID: session.id,
                proposalID: "run_legacy_handoff:confirm_legacy_handoff",
                handoffID: otherHandoff.id,
                action: "confirm",
                op: "handoff",
              }),
            ).rejects.toThrow()
            expect((await SessionTaskHandoff.get(firstHandoff.id))?.status).toBe("proposed")
            expect(Database.use((db) => db.select().from(TaskConfirmationTable).all())).toHaveLength(2)
          },
        }),
    })
    prompt.mockRestore()
  })

  test("confirms and cancels handoffs only through canonical assignment proof", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const runs: Promise<void>[] = []
    const jobs: Promise<unknown>[] = []
    const effect = spyOn(Database, "effect").mockImplementation((fn) => {
      jobs.push(Promise.resolve().then(fn))
    })
    const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => {
      entered.resolve()
      const run = gate.promise
      runs.push(run)
      return run
    }) as never)
    const enqueue = SessionPrompt.enqueue
    let attempts = 0
    const write = spyOn(SessionPrompt, "enqueue").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.enqueue>[0],
    ) => {
      attempts++
      if (attempts === 1) throw new Error("handoff enqueue failed")
      return enqueue(input)
    }) as never)
    const failed = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const update = Session.updatePart
    const part = spyOn(Session, "updatePart").mockImplementation((async (
      input: Parameters<typeof Session.updatePart>[0],
    ) => {
      const saved = await update(input)
      if (input.type !== "text" || input.metadata?.handoff_id === undefined) return saved
      if (input.metadata.status === "failed") failed.resolve()
      if (input.metadata.kind === "task_handoff_started" && input.metadata.status === "started") ready.resolve()
      return saved
    }) as never)
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
              await failed.promise
              expect(await SessionTaskHandoff.get(handoff.id)).toMatchObject({
                id: handoff.id,
                status: "failed",
                error: "handoff enqueue failed",
              })
              const retried = await app.request(`/session/${session.id}/task/handoff/${handoff.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff:confirm_handoff", action: "confirm" }),
              })
              expect(retried.status).toBe(200)
              expect(await retried.json()).toMatchObject({ status: "creating" })
              await entered.promise
              await ready.promise
              expect((await SessionTaskHandoff.get(handoff.id))?.status).toBe("started")
              const replay = await app.request(`/session/${session.id}/task/handoff/${handoff.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff:confirm_handoff", action: "confirm" }),
              })
              expect(replay.status).toBe(200)
              expect(await replay.json()).toMatchObject({ status: "started" })
              expect((await SessionTaskHandoff.get(handoff.id))?.id).toBe(handoff.id)

              const alternate = await SessionTaskHandoff.propose({
                sourceID: session.id,
                messageID,
                runID: "run_handoff",
                actionID: "confirm_handoff",
                title: "Peer task",
                body: "Peer body",
                contextRefs: ["artifact:two"],
              })
              const count = Database.use((db) => db.select({ id: SessionTable.id }).from(SessionTable).all().length)
              const mismatch = await app.request(`/session/${session.id}/task/handoff/${alternate.id}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proposal_id: "run_handoff:confirm_handoff", action: "confirm" }),
              })
              expect(mismatch.status).toBe(409)
              expect(await SessionTaskHandoff.get(alternate.id)).toMatchObject({
                status: "proposed",
                target_session_id: null,
                target_task_id: null,
              })
              expect(Database.use((db) => db.select({ id: SessionTable.id }).from(SessionTable).all())).toHaveLength(
                count,
              )

              Database.use((db) =>
                db
                  .update(TaskHandoffTable)
                  .set({ context_refs: ["artifact:tampered"] })
                  .where(eq(TaskHandoffTable.id, handoff.id))
                  .run(),
              )
              await expect(
                SessionTaskConfirmation.respond({
                  sessionID: session.id,
                  proposalID: "run_handoff:confirm_handoff",
                  handoffID: handoff.id,
                  action: "confirm",
                  op: "handoff",
                }),
              ).rejects.toBeInstanceOf(ConflictError)
              Database.use((db) => {
                db.update(TaskHandoffTable)
                  .set({ context_refs: ["artifact:one"] })
                  .where(eq(TaskHandoffTable.id, handoff.id))
                  .run()
                const proof = db
                  .select()
                  .from(TaskConfirmationTable)
                  .where(eq(TaskConfirmationTable.proposal_id, "run_handoff:confirm_handoff"))
                  .get()
                if (!proof) throw new Error("confirmation proof missing")
                db.update(TaskConfirmationTable)
                  .set({ snapshot: { ...proof.snapshot, context_refs: ["artifact:tampered"] } })
                  .where(eq(TaskConfirmationTable.id, proof.id))
                  .run()
              })
              await expect(
                SessionTaskConfirmation.respond({
                  sessionID: session.id,
                  proposalID: "run_handoff:confirm_handoff",
                  handoffID: handoff.id,
                  action: "confirm",
                  op: "handoff",
                }),
              ).rejects.toBeInstanceOf(ConflictError)

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
      gate.resolve()
      try {
        await Promise.all(runs)
        for (let index = 0; index < jobs.length; index++) await jobs[index]
      } finally {
        part.mockRestore()
        write.mockRestore()
        loop.mockRestore()
        effect.mockRestore()
        prompt.mockRestore()
      }
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

function legacy(id: string, title: string) {
  const now = Date.now()
  return AgentProtocol.Result.parse({
    type: "agent.protocol.result",
    version: "1",
    run_id: id,
    status: "completed",
    title,
    actions: [],
    summary: "Execution summary",
    time: { started: now, completed: now },
    metrics: {
      actions: 0,
      internal_tool_calls: 0,
      direct_model_tool_calls: 0,
      model_visible_bytes: 0,
      raw_output_bytes: 0,
      duration_ms: 0,
    },
  })
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

async function assistant(sessionID: SessionID) {
  const parentID = await message(sessionID)
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    parentID,
    role: "assistant",
    mode: "protocol-runner",
    agent: "protocol-runner",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-5.2"),
    providerID: ProviderID.make("openai"),
    time: { created: Date.now() },
  } as MessageV2.Assistant)
  return id
}

async function evidence(input: {
  sessionID: SessionID
  messageID: MessageID
  actionID: string
  kind: "confirm" | "input"
  assignment?: { op: "update" | "handoff"; target: "self" | "peer" }
  status?: "completed" | "pending"
}) {
  const now = Date.now()
  const payload = {
    version: "2",
    items: [
      input.kind === "confirm"
        ? {
            id: input.actionID,
            kind: "confirm",
            prompt: "Confirm task",
            plan: "Task plan",
            depends: [],
            result: "summary",
            assignment: input.assignment,
          }
        : {
            id: input.actionID,
            kind: "input",
            prompt: "Choose",
            mode: "single",
            options: [{ id: "a", label: "A", description: "A" }],
            depends: [],
            result: "summary",
          },
    ],
  }
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: `protocol_${input.actionID}`,
    tool: "AgentProtocolOutput",
    state:
      input.status === "pending"
        ? { status: "pending", input: payload, raw: "" }
        : {
            status: "completed",
            input: payload,
            output: "",
            title: "Protocol",
            metadata: {},
            time: { start: now, end: now },
          },
  })
}

async function locate(sessionID: SessionID, runID: string, actionID: string, mode: "missing" | "duplicate") {
  const session = await Session.get(sessionID)
  const protocol = (session.dsl_context?.protocol ?? {}) as Record<string, unknown>
  const confirmations = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
  const found = confirmations.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const value = item as Record<string, unknown>
    return value.run_id === runID && value.action_id === actionID
  })
  const next =
    mode === "missing"
      ? confirmations.filter((item) => !found.includes(item))
      : [...confirmations, ...(found[0] ? [{ ...(found[0] as Record<string, unknown>) }] : [])]
  await Session.setDslContext({
    sessionID,
    dsl_context: { ...session.dsl_context, protocol: { ...protocol, confirmations: next } },
  })
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

async function rewrite(sessionID: SessionID, runID: string, actionID: string, patch: Record<string, unknown>) {
  const session = await Session.get(sessionID)
  const protocol = (session.dsl_context?.protocol ?? {}) as Record<string, unknown>
  const confirmations = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
  await Session.setDslContext({
    sessionID,
    dsl_context: {
      ...session.dsl_context,
      protocol: {
        ...protocol,
        confirmations: confirmations.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item
          const value = item as Record<string, unknown>
          if (value.run_id !== runID || value.action_id !== actionID) return item
          return { ...value, ...patch }
        }),
      },
    },
  })
}
