import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLog } from "../../src/session/log"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRecovery } from "../../src/session/recovery"
import { SessionTaskRecovery } from "../../src/session/task-recovery"
import { SessionTask } from "../../src/session/task"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionDelegation } from "../../src/session/delegation"
import { SessionResult } from "../../src/session/result"
import { AgentProtocol } from "../../src/protocol/schema"
import { SessionControlTool } from "../../src/tool/session-control"
import type { Tool } from "../../src/tool/tool"
import { Database, eq } from "../../src/storage/db"
import { SessionEventOutboxTable, SessionTaskTable } from "../../src/session/session.sql"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("session recovery", () => {
  test("activates a confirmed task update once and starts it from durable bootstrap", async () => {
    await using tmp = await tmpdir({ git: true })
    const calls: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(((input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      calls.push(input)
      return Promise.resolve(undefined)
    }) as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_task_revision_recovery"),
            fn: async () => {
              const session = await Session.create({ agent: "default" })
              const first = await SessionTask.route({
                sessionID: session.id,
                runID: "run_revision_seed",
                legacy: { title: "Original", body: "Original plan" },
                actions: [],
              })
              if (first.type !== "execute") throw new Error("task missing")
              const update = await SessionTask.route({
                sessionID: session.id,
                runID: "run_revision_update",
                assignment: { op: "update", target: "self", title: "Revised", body: "Revised plan" },
                actions: [{ id: "new_work", title: "New work" }],
              })
              if (update.type !== "update") throw new Error("draft missing")

              expect(await SessionTaskRecovery.resume(session.id)).toBe(true)
              expect(await SessionTaskRecovery.resume(session.id)).toBe(true)
              expect((await SessionTask.get(session.id))?.revision.id).toBe(update.revision.id)
              expect((await SessionTask.get(session.id))?.task.status).toBe("running")
              expect(calls).toHaveLength(1)
              expect(calls[0]?.metadata).toMatchObject({
                internal: true,
                source: "task_revision_bootstrap",
                revision_id: update.revision.id,
              })
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("claims one bootstrap prompt across concurrent recovery resumes", async () => {
    await using tmp = await tmpdir({ git: true })
    let calls = 0
    let release = () => {}
    const wait = new Promise<void>((resolve) => (release = resolve))
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      calls++
      await wait
      await Session.updateMessage({
        id: input.messageID!, sessionID: input.sessionID, role: "user", time: { created: Date.now() }, agent: input.agent ?? "default",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") }, tools: {}, mode: "",
      } as MessageV2.User)
      return undefined
    }) as never)
    try {
      await Instance.provide({ directory: tmp.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_claim"),
        fn: async () => {
          const session = await Session.create({ agent: "default" })
          const first = await SessionTask.route({ sessionID: session.id, runID: "run_claim_old", legacy: { title: "Old", body: "Old" }, actions: [] })
          if (first.type !== "execute") throw new Error("task missing")
          const draft = await SessionTask.route({ sessionID: session.id, runID: "run_claim_new", assignment: { op: "update", target: "self", title: "New", body: "New" }, actions: [] })
          if (draft.type !== "update") throw new Error("draft missing")
          await SessionTask.activate({ taskID: first.task.id, revisionID: draft.revision.id, bootstrap: true })

          const resumes = Promise.all([SessionTaskRecovery.resume(session.id), SessionTaskRecovery.resume(session.id)])
          await Bun.sleep(20)
          expect(calls).toBe(1)
          release()
          await resumes
          const row = Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.session_id, session.id)).get())
          expect(row?.status).toBe("delivered")
          expect(row?.delivered_at).toBeNumber()
          expect(row?.acked_at).toBeNull()
        },
      }) })
    } finally {
      prompt.mockRestore()
    }
  })

  test("recovers bootstrap delivery leases without duplicate prompts", async () => {
    await using tmp = await tmpdir({ git: true })
    let calls = 0
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      calls++
      await Session.updateMessage({ id: input.messageID!, sessionID: input.sessionID, role: "user", time: { created: Date.now() }, agent: input.agent ?? "default", model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") }, tools: {}, mode: "" } as MessageV2.User)
      return undefined
    }) as never)
    try {
      await Instance.provide({ directory: tmp.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_lease"),
        fn: async () => {
          const seed = async (label: string) => {
            const session = await Session.create({ agent: "default" })
            const first = await SessionTask.route({ sessionID: session.id, runID: `${label}_old`, legacy: { title: "Old", body: "Old" }, actions: [] })
            if (first.type !== "execute") throw new Error("task missing")
            const draft = await SessionTask.route({ sessionID: session.id, runID: `${label}_new`, assignment: { op: "update", target: "self", title: "New", body: "New" }, actions: [] })
            if (draft.type !== "update") throw new Error("draft missing")
            await SessionTask.activate({ taskID: first.task.id, revisionID: draft.revision.id, bootstrap: true })
            return { session, row: Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.session_id, session.id)).get())! }
          }

          const fresh = await seed("fresh")
          Database.use((db) => db.update(SessionEventOutboxTable).set({ status: "delivering", updated_at: Date.now() }).where(eq(SessionEventOutboxTable.id, fresh.row.id)).run())
          await SessionTaskRecovery.resume(fresh.session.id)
          expect(calls).toBe(0)
          expect(Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.id, fresh.row.id)).get())?.status).toBe("delivering")

          const stale = await seed("stale")
          Database.use((db) => db.update(SessionEventOutboxTable).set({ status: "delivering", updated_at: Date.now() - 31_000 }).where(eq(SessionEventOutboxTable.id, stale.row.id)).run())
          await SessionTaskRecovery.resume(stale.session.id)
          expect(calls).toBe(1)
          expect(Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.id, stale.row.id)).get())?.status).toBe("delivered")

          const saved = await seed("saved")
          Database.use((db) => db.update(SessionEventOutboxTable).set({ status: "delivering", updated_at: Date.now() }).where(eq(SessionEventOutboxTable.id, saved.row.id)).run())
          await Session.updateMessage({ id: MessageID.make(String(saved.row.payload.message_id)), sessionID: saved.session.id, role: "user", time: { created: Date.now() }, agent: "default", model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") }, tools: {}, mode: "" } as MessageV2.User)
          await SessionTaskRecovery.resume(saved.session.id)
          expect(calls).toBe(1)
          expect(Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.id, saved.row.id)).get())?.status).toBe("delivered")

          const delivered = await seed("delivered")
          Database.use((db) => db.update(SessionEventOutboxTable).set({ status: "delivered", updated_at: Date.now() }).where(eq(SessionEventOutboxTable.id, delivered.row.id)).run())
          await SessionTaskRecovery.resume(delivered.session.id)
          expect(calls).toBe(1)

          const acked = await seed("acked")
          Database.use((db) => db.update(SessionEventOutboxTable).set({ status: "acked", acked_at: Date.now(), updated_at: Date.now() }).where(eq(SessionEventOutboxTable.id, acked.row.id)).run())
          await SessionTaskRecovery.resume(acked.session.id)
          expect(calls).toBe(1)
        },
      }) })
    } finally {
      prompt.mockRestore()
    }
  })

  test("blocks an activated revision and records progress when bootstrap prompt fails", async () => {
    await using tmp = await tmpdir({ git: true })
    let rejected = true
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      if (rejected) throw new Error("bootstrap rejected")
      return undefined
    }) as never)
    try {
      await Instance.provide({ directory: tmp.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_prompt_failure"),
        fn: async () => {
          const data = await revision(tmp.path, "prompt_failure")

          await expect(SessionTaskRecovery.resume(data.session.id)).rejects.toThrow("bootstrap rejected")

          expect((await SessionTask.get(data.session.id))?.task.status).toBe("blocked")
          const msg = await MessageV2.get({ sessionID: data.session.id, messageID: data.messageID })
          const progress = msg.parts.find((part) => part.type === "text" && part.metadata?.kind === "task_update_progress")
          expect(progress?.type === "text" ? progress.metadata : undefined).toMatchObject({
            kind: "task_update_progress",
            status: "blocked",
            error: "bootstrap rejected",
            draft_revision_id: data.revision.id,
          })

          rejected = false
          expect(await SessionTaskRecovery.resume(data.session.id)).toBe(true)
          expect((await SessionTask.get(data.session.id))?.task.status).toBe("running")
          const row = Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.session_id, data.session.id)).get())
          expect(row?.status).toBe("delivered")
          expect((await SessionTask.get(data.session.id))?.revision.id).toBe(data.revision.id)
        },
      }) })
    } finally {
      prompt.mockRestore()
    }
  })

  test("scan persists blocked progress instead of silently swallowing bootstrap failure", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockRejectedValue(new Error("scan bootstrap rejected"))
    try {
      await Instance.provide({ directory: tmp.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_scan_failure"),
        fn: async () => {
          const data = await revision(tmp.path, "scan_failure")

          expect(await SessionTaskRecovery.scan()).toEqual([false])

          expect((await SessionTask.get(data.session.id))?.task.status).toBe("blocked")
          const msg = await MessageV2.get({ sessionID: data.session.id, messageID: data.messageID })
          const progress = msg.parts.find((part) => part.type === "text" && part.metadata?.kind === "task_update_progress")
          expect(progress?.type === "text" ? progress.metadata : undefined).toMatchObject({
            kind: "task_update_progress",
            status: "blocked",
            error: "scan bootstrap rejected",
            draft_revision_id: data.revision.id,
          })
        },
      }) })
    } finally {
      prompt.mockRestore()
    }
  })

  test("reconciles delivered bootstrap state for only the current blocked revision", async () => {
    await using tmp = await tmpdir({ git: true })
    let calls = 0
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      calls++
      return undefined
    }) as never)
    try {
      await Instance.provide({ directory: tmp.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_delivered_reconcile"),
        fn: async () => {
          const delivered = await revision(tmp.path, "delivered_reconcile")
          const acked = await revision(tmp.path, "acked_reconcile")
          const stale = await revision(tmp.path, "stale_reconcile")
          for (const [data, status] of [[delivered, "delivered"], [acked, "acked"]] as const) {
            Database.use((db) => {
              db.update(SessionEventOutboxTable)
                .set({ status, delivered_at: Date.now(), acked_at: status === "acked" ? Date.now() : null })
                .where(eq(SessionEventOutboxTable.session_id, data.session.id))
                .run()
              db.update(SessionTaskTable)
                .set({ status: "blocked" })
                .where(eq(SessionTaskTable.session_id, data.session.id))
                .run()
            })
          }
          Database.use((db) => {
            const row = db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.session_id, stale.session.id)).get()!
            db.update(SessionEventOutboxTable)
              .set({ status: "delivered", delivered_at: Date.now(), payload: { ...row.payload, revision_id: stale.revision.previous_id } })
              .where(eq(SessionEventOutboxTable.id, row.id))
              .run()
            db.update(SessionTaskTable).set({ status: "blocked" }).where(eq(SessionTaskTable.session_id, stale.session.id)).run()
          })
          const before = await Promise.all(
            [delivered, acked, stale].map((data) => MessageV2.filterCompacted(MessageV2.stream(data.session.id))),
          )

          expect(await SessionTaskRecovery.resume(delivered.session.id)).toBe(true)
          expect((await SessionTask.get(delivered.session.id))?.task.status).toBe("running")
          expect((await SessionTask.get(delivered.session.id))?.revision.id).toBe(delivered.revision.id)
          expect(await SessionTaskRecovery.scan()).toContain(true)
          expect((await SessionTask.get(acked.session.id))?.task.status).toBe("running")
          expect((await SessionTask.get(acked.session.id))?.revision.id).toBe(acked.revision.id)
          expect((await SessionTask.get(stale.session.id))?.task.status).toBe("blocked")
          expect((await SessionTask.get(stale.session.id))?.revision.id).toBe(stale.revision.id)
          const after = await Promise.all(
            [delivered, acked, stale].map((data) => MessageV2.filterCompacted(MessageV2.stream(data.session.id))),
          )
          expect(after.map((items) => items.length)).toEqual(before.map((items) => items.length))
          expect(calls).toBe(0)
        },
      }) })
    } finally {
      prompt.mockRestore()
    }
  })

  test("scan advances only task recovery rows from the current project directory", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    let calls = 0
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      calls++
      return undefined
    }) as never)
    try {
      const foreign = await Instance.provide({ directory: b.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_scan_foreign"),
        fn: async () => {
          const parent = await Session.create({ agent: "default" })
          const child = await Session.create({ parentID: parent.id, agent: "backend" })
          const old = action("foreign_child", "delegate", "backend")
          const first = await SessionTask.route({
            sessionID: parent.id,
            runID: "run_foreign_old",
            legacy: { title: "Foreign old", body: "Foreign old" },
            actions: [old],
          })
          if (first.type !== "execute") throw new Error("foreign task missing")
          await SessionAssignment.delegate({
            action: old,
            childID: child.id,
            messageID: MessageID.ascending(),
            runID: "run_foreign_old",
            sessionID: parent.id,
          })
          SessionStatus.set(child.id, { type: "running" })
          const draft = await SessionTask.route({
            sessionID: parent.id,
            runID: "run_foreign_new",
            assignment: { op: "update", target: "self", title: "Foreign new", body: "Foreign new" },
            actions: [],
          })
          if (draft.type !== "update") throw new Error("foreign draft missing")
          return { parent, child, revision: first.revision.id }
        },
      }) })

      await Instance.provide({ directory: a.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_scan_current"),
        fn: async () => {
          const current = await revision(a.path, "scan_current")
          expect(await SessionTaskRecovery.scan()).toContain(true)
          expect((await SessionTask.get(current.session.id))?.task.status).toBe("running")
          expect((await SessionTask.get(current.session.id))?.revision.id).toBe(current.revision.id)
        },
      }) })

      await Instance.provide({ directory: b.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_scan_foreign_check"),
        fn: async () => {
          expect((await SessionTask.get(foreign.parent.id))?.task.status).toBe("revising")
          expect((await SessionTask.get(foreign.parent.id))?.revision.id).toBe(foreign.revision)
          expect(SessionStatus.get(foreign.child.id).type).toBe("running")
          expect(Database.use((db) => db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.session_id, foreign.parent.id)).get())).toBeUndefined()
        },
      }) })
      expect(calls).toBe(1)
    } finally {
      prompt.mockRestore()
    }
  })

  test("reconstructs direct revision stop from canonical assignment rows after restart", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({ directory: tmp.path, fn: () => WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_revision_canonical_stop"),
        fn: async () => {
          const parent = await Session.create({ agent: "default" })
          const old = action("canonical_child", "delegate", "backend")
          const first = await SessionTask.route({
            sessionID: parent.id,
            runID: "run_canonical_old",
            legacy: { title: "Old", body: "Old" },
            actions: [old],
          })
          if (first.type !== "execute") throw new Error("task missing")
          const child = await Session.create({ parentID: parent.id, agent: "backend" })
          const msg = MessageID.ascending()
          await SessionAssignment.delegate({ action: old, childID: child.id, messageID: msg, runID: "run_canonical_old", sessionID: parent.id })
          await SessionDelegation.assign({
            action: old,
            agent: "backend",
            childID: child.id,
            messageID: msg,
            parentAgent: "default",
            runID: "run_canonical_old",
            sessionID: parent.id,
          })
          SessionStatus.set(child.id, { type: "running" })

          const saved = await Session.get(child.id)
          const protocol = (saved.dsl_context?.protocol ?? {}) as Record<string, unknown>
          const delegation = protocol.delegation as Record<string, unknown>
          await Session.setDslContext({
            sessionID: child.id,
            dsl_context: { ...saved.dsl_context, protocol: { ...protocol, delegation: { ...delegation, action_id: "forged_action" } } },
          })
          const root = await Session.get(parent.id)
          const parentProtocol = (root.dsl_context?.protocol ?? {}) as Record<string, unknown>
          await Session.setDslContext({
            sessionID: parent.id,
            dsl_context: { ...root.dsl_context, protocol: { ...parentProtocol, pending_delegations: {} } },
          })

          const draft = await SessionTask.route({
            sessionID: parent.id,
            runID: "run_canonical_new",
            assignment: { op: "update", target: "self", title: "New", body: "New" },
            actions: [],
          })
          if (draft.type !== "update") throw new Error("draft missing")
          await SessionTaskRecovery.resume(parent.id)

          expect((await SessionTask.get(parent.id))?.revision.id).toBe(draft.revision.id)
          const results = await SessionResult.listForParent(parent.id)
          expect(results).toHaveLength(1)
          expect(results[0]?.action_id).toBe(old.id)
          expect(results[0]?.action_id).not.toBe("forged_action")
        },
      }) })
    } finally {
      prompt.mockRestore()
    }
  })

  test("collects every scoped child before activation and ignores unrelated tree sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const calls: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      calls.push(input)
      if (input.metadata?.source === "task_revision_bootstrap") return undefined
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
      const assistant = (await Session.updateMessage({
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
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: "Recovered partial child result with task revision stop reason.",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_task_revision_children"),
            fn: async () => {
              const parent = await Session.create({ agent: "default" })
              const confirm = action("confirm_create", "confirm", "user")
              confirm.input = { assignment: { op: "create", target: "self" }, plan: "Original plan" }
              const actions = [
                action("running", "delegate", "backend"),
                action("completed", "delegate", "backend"),
                action("missing", "delegate", "backend"),
                action("stuck", "delegate", "backend"),
                action("tool", "delegate", "backend"),
              ]
              const assignment = await SessionAssignment.confirm({
                action: confirm,
                messageID: MessageID.ascending(),
                plan: "Original plan",
                runID: "run_task_children",
                sessionID: parent.id,
              })
              if (!assignment) throw new Error("assignment missing")
              const original = await SessionTask.confirmed({
                sessionID: parent.id,
                runID: "run_task_children",
                actionIDs: [confirm.id],
                actions: [confirm, ...actions],
                legacy: { title: "Original", body: "Original plan" },
                requiresAssignment: true,
              })
              if (original.type !== "execute") throw new Error("task missing")

              const children = await Promise.all(
                actions.map(async (item) => {
                  const child = await Session.create({ parentID: parent.id, agent: "backend" })
                  await SessionAssignment.delegate({
                    action: item,
                    childID: child.id,
                    messageID: MessageID.ascending(),
                    runID: "run_task_children",
                    sessionID: parent.id,
                  })
                  return child
                }),
              )
              for (const index of [0, 1, 2]) {
                await SessionDelegation.assign({
                  action: actions[index]!,
                  agent: "backend",
                  childID: children[index]!.id,
                  messageID: MessageID.ascending(),
                  parentAgent: "default",
                  runID: "run_task_children",
                  sessionID: parent.id,
                })
              }
              SessionStatus.set(children[0]!.id, { type: "running" })
              SessionStatus.set(children[1]!.id, { type: "completed" })
              SessionStatus.set(children[2]!.id, { type: "completed" })
              SessionStatus.set(children[3]!.id, { type: "running" })
              SessionStatus.set(children[4]!.id, { type: "running" })
              await SessionResult.put({
                carrier: "action_result",
                status: "completed",
                satisfying: true,
                sessionID: children[1]!.id,
                parentSessionID: parent.id,
                childSessionID: children[1]!.id,
                runID: "run_task_children",
                actionID: "completed",
                summary: "Completed native result",
                raw: {
                  output: "Completed native result",
                  input: { kind: "action_result", role: "worker", action_id: "completed", status: "success" },
                },
              })
              const unrelated = await Session.create({ parentID: parent.id, agent: "backend" })
              SessionStatus.set(unrelated.id, { type: "running" })
              const update = await SessionTask.route({
                sessionID: parent.id,
                runID: "run_task_update",
                assignment: { op: "update", target: "self", title: "Revised", body: "Revised plan" },
                actions: [{ id: "replacement" }],
              })
              if (update.type !== "update") throw new Error("draft missing")

              const tool = await SessionControlTool.init()
              const context = control(parent.id)
              const listed = JSON.parse((await tool.execute({ action: "list" }, context)).output) as {
                session_id: string
              }[]
              expect(listed.map((item) => item.session_id).sort()).toEqual(children.map((item) => item.id).sort())
              expect(listed.map((item) => item.session_id)).not.toContain(unrelated.id)
              await tool.execute({ action: "stop", session_ids: [children[4]!.id] }, context)
              expect(SessionStatus.get(children[4]!.id).type).toBe("user_completed")

              expect(await SessionTaskRecovery.resume(parent.id)).toBe(true)
              expect((await SessionTask.get(parent.id))?.task.status).toBe("running")
              expect((await SessionTask.get(parent.id))?.revision.id).toBe(update.revision.id)
              expect(SessionStatus.get(children[0]!.id).type).toBe("user_completed")
              expect(SessionStatus.get(children[1]!.id).type).toBe("completed")
              expect(SessionStatus.get(children[2]!.id).type).toBe("completed")
              expect(SessionStatus.get(children[3]!.id).type).toBe("user_completed")
              expect(SessionStatus.get(children[4]!.id).type).toBe("user_completed")
              expect(SessionStatus.get(unrelated.id).type).toBe("running")
              const first = await SessionResult.listForParent(parent.id)
              const running = first.find((item) => item.child_session_id === children[0]!.id)
              const completed = first.find((item) => item.child_session_id === children[1]!.id)
              const missing = first.find((item) => item.child_session_id === children[2]!.id)
              expect(running?.status).toBe("partial")
              expect((await SessionResult.parse(running?.id ?? ""))?.output).toContain("task revision stop reason")
              expect(completed?.summary).toBe("Completed native result")
              expect((await SessionResult.parse(completed?.id ?? ""))?.output).toBe("Completed native result")
              expect(missing?.status).toBe("partial")
              expect((await SessionResult.parse(missing?.id ?? ""))?.output).toContain("task revision stop reason")
              expect(first.find((item) => item.child_session_id === children[3]!.id)?.status).toBe("partial")
              expect(first.find((item) => item.child_session_id === children[4]!.id)?.status).toBe("partial")
              const results = first
              const ids = results.map((item) => item.id).sort()
              const summaries = calls.filter((item) => item.agent === "summary").length
              const bootstraps = calls.filter((item) => item.metadata?.source === "task_revision_bootstrap").length
              expect(results.filter((item) => children.some((child) => child.id === item.child_session_id))).toHaveLength(5)
              expect(bootstraps).toBe(1)
              expect(await SessionTaskRecovery.resume(parent.id)).toBe(true)
              expect(await SessionTaskRecovery.scan()).toContain(true)
              expect((await SessionResult.listForParent(parent.id)).map((item) => item.id).sort()).toEqual(ids)
              expect(calls.filter((item) => item.agent === "summary")).toHaveLength(summaries)
              expect(calls.filter((item) => item.metadata?.source === "task_revision_bootstrap")).toHaveLength(1)
              SessionStatus.set(unrelated.id, { type: "idle" })
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("marks stale running tools and records recovery packet", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_stale"),
          fn: async () => {
            const data = await stale(tmp.path, "git push origin main")
            await SessionLog.emit({
              sessionID: data.sessionID,
              messageID: data.messageID,
              partID: data.partID,
              level: "info",
              type: "tool.start",
              data: { tool: "bash" },
              time: data.start,
            })
            await SessionLog.emit({
              sessionID: data.sessionID,
              level: "info",
              type: "permission.asked",
              data: { command: "git push origin main" },
              time: data.start + 1,
            })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(1)
            expect(packets[0].session_id).toBe(data.sessionID)
            expect(packets[0].tools[0].tool).toBe("bash")
            expect(packets[0].tools[0].risk).toBe("high")
            expect(packets[0].tools[0].recovery_hint).toBe("requires_user_confirmation")
            expect(packets[0].tools[0].logs).toContain("tool.start")
            expect(packets[0].tools[0].logs).toContain("permission.asked")

            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("error")
            if (part.state.status !== "error") return
            expect(part.state.error).toContain("interrupted")
            expect(part.state.metadata?.recovery?.status).toBe("stale_interrupted")
            expect(part.state.metadata?.recovery?.risk).toBe("high")

            const logs = await SessionLog.list({ sessionID: data.sessionID, limit: 100 })
            expect(logs.map((item) => item.type)).toContain("session.recovery.detected")
            expect(logs.map((item) => item.type)).toContain("session.recovery.tool_marked_stale")
          },
        }),
    })
  })

  test("does not mark tools for sessions active in current process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_active"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "running" })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(0)
            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("running")
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })

  test("marks tools for sessions interrupted by a previous process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_interrupted"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "interrupted", prior: "running" })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(1)
            expect(packets[0].session_id).toBe(data.sessionID)
            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("error")
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })
  test("lists sessions whose stale tools were already marked", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_marked"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "interrupted", prior: "running" })

            await SessionRecovery.mark()
            expect(await SessionRecovery.detect()).toHaveLength(0)
            expect(await SessionRecovery.marked()).toContain(data.sessionID)
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })
})

async function stale(dir: string, command: string) {
  const session = await Session.create({ title: "recovery-test" })
  const user = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)

  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    parentID: user,
    role: "assistant",
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    path: {
      cwd: dir,
      root: dir,
    },
    time: { created: Date.now() },
    sessionID: session.id,
  } as MessageV2.Assistant)

  const start = Date.now()
  const partID = PartID.ascending()
  await Session.updatePart({
    id: partID,
    sessionID: session.id,
    messageID,
    type: "tool",
    callID: "call_recovery",
    tool: "bash",
    state: {
      status: "running",
      input: { command },
      title: command,
      time: { start },
    },
  })

  return {
    sessionID: session.id as SessionID,
    messageID,
    partID,
    start,
  }
}

function action(id: string, operation: string, target: string) {
  return {
    type: "action",
    id,
    title: id,
    operation,
    executor:
      target === "user"
        ? { type: "human", target, capabilities: ["confirmation"] }
        : { type: "agent", target, capabilities: ["implementation"] },
    input: {},
    depends_on: [],
    context_refs: [],
    result_policy: "summary",
  } as AgentProtocol.Action
}

function control(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "default",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

async function revision(dir: string, label: string) {
  const session = await Session.create({ agent: "default" })
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
  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    parentID: user.id,
    role: "assistant",
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-5.2"),
    providerID: ProviderID.make("openai"),
    time: { created: Date.now() },
  } as MessageV2.Assistant)
  const first = await SessionTask.route({
    sessionID: session.id,
    messageID,
    runID: `run_${label}_old`,
    legacy: { title: "Old", body: "Old" },
    actions: [],
  })
  if (first.type !== "execute") throw new Error("task missing")
  const draft = await SessionTask.route({
    sessionID: session.id,
    messageID,
    runID: `run_${label}_new`,
    assignment: { op: "update", target: "self", title: "New", body: "New" },
    actions: [],
  })
  if (draft.type !== "update") throw new Error("draft missing")
  await SessionTask.activate({ taskID: first.task.id, revisionID: draft.revision.id, bootstrap: true })
  return { session, messageID, revision: draft.revision }
}
