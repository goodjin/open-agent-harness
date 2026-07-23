import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import { symlink, unlink } from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { AgentProtocol } from "../../src/protocol/schema"
import { Session } from "../../src/session"
import { SessionRuns } from "../../src/session/runs"
import { SessionAssignment } from "../../src/session/assignment"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  AssignmentTable,
  SessionEventOutboxTable,
  SessionResultTable,
  SessionTaskTable,
  TaskHandoffTable,
  TaskRevisionTable,
} from "../../src/session/session.sql"
import { locators, SessionTask } from "../../src/session/task"
import { TaskLedger } from "../../src/session/task-ledger"
import { Markdown, TaskDocuments } from "../../src/session/task-documents"
import { TaskFS } from "../../src/session/task-fs"
import { Database, eq, inArray, sql } from "../../src/storage/db"
import { Storage } from "../../src/storage/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { Flag } from "../../src/flag/flag"

const posix = process.platform === "darwin" || process.platform === "linux" ? test : test.skip
const ledger = Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER

afterEach(async () => {
  // @ts-expect-error test-only flag override
  Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = ledger
  await resetDatabase()
})

async function setup(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () =>
      WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_session_task"),
        fn,
      }),
  })
}

async function scoped(input: {
  id: string
  root: string
  locators: readonly { run: string; action: string; parent: string }[]
}) {
  const session = await Session.create({})
  const first = await SessionTask.create({
    sessionID: session.id,
    title: input.id,
    body: `# ${input.id}\n`,
    source: { type: "user" },
  })
  const run = `run_${input.id}`
  const action = `action_${input.id}`
  const children = await Promise.all(input.locators.map(() => Session.create({ parentID: session.id })))
  const assignments = await Promise.all(
    input.locators.map((item, index) => {
      const planned = {
        type: "action",
        id: item.action,
        title: item.action,
        operation: "delegate",
        executor: { type: "agent", target: "backend", capabilities: [] },
        input: {},
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      return SessionAssignment.delegate({
        action: planned,
        childID: children[index]!.id,
        messageID: MessageID.ascending(),
        runID: item.run,
        sessionID: session.id,
      })
    }),
  )
  Database.use((db) => {
    db.update(TaskRevisionTable)
      .set({
        workflow: {
          assignment_id: input.root,
          actions: result(run, [{ id: action, title: action, status: "completed" }]).actions.map((item) => ({
            ...item,
            executor: { type: "agent", target: "backend", capabilities: [] },
            run_id: run,
          })),
        },
      })
      .where(eq(TaskRevisionTable.id, first.revision.id))
      .run()
    input.locators.forEach((item, index) => {
      db.update(AssignmentTable)
        .set({ parent_id: item.parent })
        .where(eq(AssignmentTable.id, assignments[index]!.id))
        .run()
      db.insert(SessionResultTable)
        .values({
          id: `result_scope_${input.id}_${index}`,
          carrier: "action_result",
          status: "completed",
          satisfying: true,
          session_id: children[index]!.id,
          parent_session_id: session.id,
          child_session_id: children[index]!.id,
          run_id: item.run,
          action_id: item.action,
          target_action_id: null,
          raw_ref: `scope/${input.id}/${index}`,
          summary: "Scoped result",
          created_at: Date.now(),
        })
        .run()
    })
  })
  const draft = await SessionTask.draft({ taskID: first.task.id, title: "Current", body: "# Current\n" })
  await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
  return SessionTask.revision(session.id, 1)
}

async function legacy(input: {
  assignment: SessionAssignment.Info
  plan: string
  route?: { op: "create" | "update" | "handoff"; target: string }
  source: Record<string, unknown>
  stored?: string
}) {
  const ref = ["session_assignment_content", input.assignment.id, `rev-${input.assignment.content_version}`]
  await Storage.write(ref, {
    type: "assignment.content",
    version: 1,
    assignment_id: input.assignment.id,
    revision: input.assignment.content_version,
    plan: input.stored ?? input.plan,
    assignment: input.route,
    source: input.source,
  })
  Database.use((tx) =>
    tx
      .update(AssignmentTable)
      .set({
        content_ref: ref.join("/"),
        content_hash: new Bun.CryptoHasher("sha256").update(input.plan).digest("hex"),
      })
      .where(eq(AssignmentTable.id, input.assignment.id))
      .run(),
  )
}

async function until<T>(fn: () => T | Promise<T>, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error("condition timeout")
}

async function lock(time = 250) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { Database } from "bun:sqlite"
        const db = new Database(process.env.DB_PATH)
        db.run("BEGIN IMMEDIATE")
        console.log("locked")
        await Bun.sleep(Number(process.env.LOCK_TIME))
        db.run("COMMIT")
        db.close()
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: { ...process.env, DB_PATH: Database.Path, LOCK_TIME: String(time) },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const signal = await proc.stdout.getReader().read()
  expect(new TextDecoder().decode(signal.value)).toContain("locked")
  return proc
}

type Child = {
  status: "success" | "conflict"
  version?: number
  error?: string
}

async function child(op: "create" | "draft", input: Record<string, unknown>, gate?: { ready: string; start: string }) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { SessionTask } from "./src/session/task.ts"
        import { Database } from "./src/storage/db.ts"
        const gate = process.env.TASK_GATE ? JSON.parse(process.env.TASK_GATE) : undefined
        if (gate) {
          await Bun.write(gate.ready, "ready")
          while (!(await Bun.file(gate.start).exists())) await Bun.sleep(5)
        }
        const input = JSON.parse(process.env.TASK_INPUT)
        try {
          const result = await SessionTask[process.env.TASK_OP](input)
          console.log("TASK_RESULT:" + JSON.stringify({
            status: "success",
            version: result.revision?.version ?? result.version,
          }))
        } catch (err) {
          if (!(err instanceof SessionTask.Conflict)) throw err
          console.log("TASK_RESULT:" + JSON.stringify({ status: "conflict", error: err.message }))
        } finally {
          Database.close()
        }
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        TASK_GATE: gate ? JSON.stringify(gate) : "",
        TASK_OP: op,
        TASK_INPUT: JSON.stringify(input),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  const line = stdout.split("\n").find((item) => item.startsWith("TASK_RESULT:"))
  if (!line) throw new Error(`Missing child result: ${stdout}`)
  return JSON.parse(line.slice("TASK_RESULT:".length)) as Child
}

async function project(input: Record<string, unknown>, gate?: { ready: string; start: string }) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { Instance } from "./src/project/instance.ts"
        import { TaskDocuments } from "./src/session/task-documents.ts"
        const gate = process.env.TASK_GATE ? JSON.parse(process.env.TASK_GATE) : undefined
        if (gate) {
          await Bun.write(gate.ready, "ready")
          while (!(await Bun.file(gate.start).exists())) await Bun.sleep(5)
        }
        const input = JSON.parse(process.env.TASK_INPUT)
        const result = await Instance.provide({
          directory: process.env.TASK_PROJECT,
          fn: () => TaskDocuments.publish(input),
        })
        console.log("PROJECT_RESULT:" + JSON.stringify(result))
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        TASK_GATE: gate ? JSON.stringify(gate) : "",
        TASK_INPUT: JSON.stringify(input),
        TASK_PROJECT: Instance.directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout
}

async function ready(file: string) {
  for (let count = 0; count < 200; count++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

describe("session task", () => {
  test("routes executable packages into one current task revision", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.route({
        sessionID: session.id,
        runID: "run_task_v1",
        messageID: MessageID.ascending(),
        assignment: { op: "create", target: "self", title: "Implement task binding", body: "Approved plan" },
        actions: [{ id: "write", title: "Write code", run_id: "run_task_v1" }],
      })
      expect(first.type).toBe("execute")
      expect((await SessionTask.get(session.id))?.revision.workflow).toEqual({
        run_id: "run_task_v1",
        run_ids: ["run_task_v1"],
        actions: [{ id: "write", title: "Write code", run_id: "run_task_v1" }],
      })

      const next = await SessionTask.route({
        sessionID: session.id,
        runID: "run_task_v2",
        messageID: MessageID.ascending(),
        actions: [
          { id: "write", title: "Write code", run_id: "run_task_v1" },
          { id: "write", title: "Write code", run_id: "run_task_v2" },
          { id: "verify", title: "Verify code", run_id: "run_task_v2" },
        ],
      })
      expect(next.type).toBe("execute")
      expect((await SessionTask.get(session.id))?.revision.workflow).toEqual({
        run_id: "run_task_v2",
        run_ids: ["run_task_v1", "run_task_v2"],
        actions: [
          { id: "write", title: "Write code", run_id: "run_task_v1" },
          { id: "write", title: "Write code", run_id: "run_task_v2" },
          { id: "verify", title: "Verify code", run_id: "run_task_v2" },
        ],
      })
      expect(await SessionTask.history(session.id)).toHaveLength(0)
    }))

  test("routes conflicting assignments before executable work", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_task_create",
        assignment: { op: "create", target: "self", title: "First task", body: "First plan" },
        actions: [{ id: "first" }],
      })
      await expect(
        SessionTask.route({
          sessionID: session.id,
          runID: "run_task_conflict",
          assignment: { op: "create", target: "self", title: "Second task", body: "Second plan" },
          actions: [{ id: "second" }],
        }),
      ).rejects.toThrow("session_task_already_bound")
      await expect(
        SessionTask.preflight(session.id, [
          {
            operation: "confirm",
            executor: { type: "human" },
            input: { assignment: { op: "create", target: "self" } },
          },
          { id: "second", operation: "tool", executor: { type: "tool", target: "read" } },
        ]),
      ).rejects.toThrow("session_task_already_bound")
      expect((await SessionTask.get(session.id))?.revision.workflow.actions).toEqual([
        { id: "first", run_id: "run_task_create" },
      ])
    }))

  test("keeps current task context compact and finishes the expected run idempotently", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_task_finish",
        assignment: { op: "create", target: "self", title: "Finish task", body: "Sensitive full body" },
        actions: [{ id: "finish" }],
      })
      const context = await SessionTask.context(session.id)
      expect(context).toContain("Finish task")
      expect(context).not.toContain("Sensitive full body")
      expect(context).not.toContain('"finish"')

      await SessionTask.finish({
        sessionID: session.id,
        runID: "run_task_finish",
        summary: "Terminal protocol result",
        source: "protocol",
      })
      await SessionTask.finish({
        sessionID: session.id,
        runID: "run_task_finish",
        summary: "Terminal protocol result",
        source: "protocol",
      })
      expect(await SessionTask.current(session.id)).toMatchObject({
        status: "completed",
        result: "Terminal protocol result",
        result_source: "protocol",
      })
      await expect(
        SessionTask.finish({
          sessionID: session.id,
          runID: "run_task_finish",
          summary: "Different terminal result",
          source: "protocol",
        }),
      ).rejects.toThrow("session_task_result_conflict")
    }))

  test("reopens a completed main task for a new run without losing workflow history", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_main_first",
        assignment: { op: "create", target: "self", title: "Main task", body: "Main task body" },
        actions: [{ id: "first" }],
      })
      await SessionTask.finish({
        sessionID: session.id,
        runID: "run_main_first",
        summary: "First run completed",
        source: "protocol",
      })

      const saved = await SessionTask.route({
        sessionID: session.id,
        runID: "run_main_second",
        actions: [{ id: "second" }],
      })

      expect(saved).toMatchObject({
        type: "execute",
        task: { status: "running", source_type: "user" },
        revision: {
          status: "active",
          result: null,
          result_source: null,
          time_completed: null,
          workflow: {
            run_id: "run_main_second",
            run_ids: ["run_main_first", "run_main_second"],
            actions: [
              { id: "first", run_id: "run_main_first" },
              { id: "second", run_id: "run_main_second" },
            ],
          },
        },
      })
    }))

  test("does not reopen a completed delegated task from a local run", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const saved = await SessionTask.route({
        sessionID: child.id,
        legacy: { title: "Delegated task", body: "Delegated task body" },
        source: {
          type: "delegation",
          sessionID: parent.id,
          runID: "run_parent",
          actionID: "delegate_child",
        },
        actions: [],
      })
      if (saved.type !== "execute") throw new Error("delegated task missing")
      Database.use((tx) => {
        tx.update(TaskRevisionTable)
          .set({ status: "completed", result: "Delivered", result_source: "action_result", time_completed: Date.now() })
          .where(eq(TaskRevisionTable.id, saved.revision.id))
          .run()
        tx.update(SessionTaskTable).set({ status: "completed" }).where(eq(SessionTaskTable.id, saved.task.id)).run()
      })

      await expect(
        SessionTask.route({
          sessionID: child.id,
          runID: "run_child_again",
          actions: [{ id: "again" }],
        }),
      ).rejects.toThrow("session_task_revision_not_active")
    }))

  test("binds delegated child source once and rejects mismatched recovery", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const action = {
        type: "action",
        id: "delegate_child",
        title: "Delegated child",
        operation: "agent",
        executor: { type: "agent", target: "worker", capabilities: [] },
        input: { prompt: "Canonical delegation plan" },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const input = {
        sessionID: child.id,
        parentSessionID: parent.id,
        parentRunID: "run_parent",
        parentActionID: "delegate_child",
      }
      await expect(SessionTask.beginDelegated(input)).rejects.toThrow("session_task_delegation_assignment_missing")
      await SessionAssignment.delegate({
        action,
        childID: child.id,
        messageID: MessageID.ascending(),
        plan: "Canonical delegation plan",
        runID: "run_parent",
        sessionID: parent.id,
      })
      await SessionTask.beginDelegated(input)
      await SessionTask.beginDelegated(input)
      expect((await SessionTask.get(child.id))?.task.source_ref).toMatchObject({
        sessionID: parent.id,
        runID: "run_parent",
        actionID: "delegate_child",
      })
      expect(await SessionTask.history(child.id)).toHaveLength(0)
      await expect(
        SessionTask.beginDelegated({
          sessionID: child.id,
          parentSessionID: parent.id,
          parentRunID: "run_wrong",
          parentActionID: "delegate_child",
        }),
      ).rejects.toThrow("session_task_delegation_assignment_missing")
    }))

  test("does not let a delegated assignment bypass a multi-run migration confirmation", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const action = {
        type: "action",
        id: "delegate_legacy_child",
        title: "Delegated legacy child",
        operation: "agent",
        executor: { type: "agent", target: "worker", capabilities: [] },
        input: { prompt: "Delegated plan" },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      await SessionAssignment.delegate({
        action,
        childID: child.id,
        messageID: MessageID.ascending(),
        plan: "Delegated plan",
        runID: "run_delegate_legacy",
        sessionID: parent.id,
      })
      await legacyRuns(child.id, "delegated")
      await expect(
        SessionTask.beginDelegated({
          sessionID: child.id,
          parentSessionID: parent.id,
          parentRunID: "run_delegate_legacy",
          parentActionID: action.id,
        }),
      ).rejects.toThrow("session_task_conflict")
      expect(await SessionTask.get(child.id)).toBeUndefined()
    }))

  test("routes update to a draft and handoff away from source execution", () =>
    setup(async () => {
      const empty = await Session.create({})
      for (const op of ["update", "handoff"] as const) {
        await expect(
          SessionTask.preflight(empty.id, [
            {
              operation: "confirm",
              executor: { type: "human" },
              input: { assignment: { op, target: op === "handoff" ? "peer" : "self" } },
            },
          ]),
        ).rejects.toThrow(
          op === "handoff" ? "task_handoff_requires_bound_source" : "session_task_update_requires_bound_source",
        )
      }
      await expect(
        SessionTask.preflight(empty.id, [
          { operation: "confirm", executor: { type: "human" }, input: { assignment: { op: "create" } } },
          { operation: "confirm", executor: { type: "human" }, input: { assignment: { op: "handoff" } } },
        ]),
      ).rejects.toThrow("session_task_assignment_ambiguous")
      await expect(
        SessionTask.route({
          sessionID: empty.id,
          runID: "run_handoff_empty",
          assignment: { op: "handoff", target: "peer", title: "Peer task", body: "Peer plan" },
          actions: [{ id: "peer" }],
        }),
      ).rejects.toThrow("task_handoff_requires_bound_source")

      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_active",
        assignment: { op: "create", target: "self", title: "Active task", body: "Active plan" },
        actions: [{ id: "active", run_id: "run_active" }],
      })
      const update = await SessionTask.route({
        sessionID: session.id,
        runID: "run_update",
        assignment: { op: "update", target: "self", title: "Updated task", body: "Updated plan" },
        actions: [{ id: "updated" }],
      })
      expect(update).toMatchObject({ type: "update", revision: { version: 2, status: "draft" } })
      expect(await SessionTask.current(session.id)).toMatchObject({ title: "Active task", version: 1 })

      const handoff = await SessionTask.route({
        sessionID: session.id,
        runID: "run_handoff",
        assignment: { op: "handoff", target: "peer", title: "Peer task", body: "Peer plan" },
        actions: [{ id: "peer" }],
      })
      expect(handoff.type).toBe("handoff")
      expect((await SessionTask.get(session.id))?.revision.workflow).toEqual({
        run_id: "run_active",
        run_ids: ["run_active"],
        actions: [{ id: "active", run_id: "run_active" }],
      })
    }))

  test("freezes the active revision when a confirmed update creates its draft", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.route({
        sessionID: session.id,
        runID: "run_update_freeze_seed",
        legacy: { title: "Original task", body: "Original plan" },
        actions: [{ id: "original" }],
      })
      if (first.type !== "execute") throw new Error("task missing")

      const update = await SessionTask.route({
        sessionID: session.id,
        runID: "run_update_freeze",
        assignment: { op: "update", target: "self", title: "Updated task", body: "Updated plan" },
        actions: [{ id: "replacement" }],
      })

      expect(update).toMatchObject({ type: "update", revision: { status: "draft", previous_id: first.revision.id } })
      expect((await SessionTask.get(session.id))?.task.status).toBe("revising")
      expect((await SessionTask.get(session.id))?.revision.id).toBe(first.revision.id)
      await expect(
        SessionTask.sync({ sessionID: session.id, runID: "run_update_freeze_seed", actions: [] }),
      ).rejects.toThrow("session_task_stale_run")
      await expect(
        SessionTask.route({
          sessionID: session.id,
          runID: "run_late_old_revision",
          actions: [{ id: "must_not_attach" }],
        }),
      ).rejects.toThrow("session_task_revision_frozen")
    }))

  test("keeps revision shutdown scope limited to the frozen active workflow", () =>
    setup(async () => {
      const session = await Session.create({})
      const old = {
        type: "action",
        id: "old_child",
        title: "Old child",
        operation: "delegate",
        executor: { type: "agent", target: "backend", capabilities: [] },
        input: {},
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const next = { ...old, id: "draft_child", title: "Draft child" }
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_scope_old",
        legacy: { title: "Original", body: "Original plan" },
        actions: [old],
      })
      const oldSession = await Session.create({ parentID: session.id })
      const draftSession = await Session.create({ parentID: session.id })
      await SessionAssignment.delegate({
        action: old,
        childID: oldSession.id,
        messageID: MessageID.ascending(),
        runID: "run_scope_old",
        sessionID: session.id,
      })
      await SessionAssignment.delegate({
        action: next,
        childID: draftSession.id,
        messageID: MessageID.ascending(),
        runID: "run_scope_new",
        sessionID: session.id,
      })
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_scope_new",
        assignment: { op: "update", target: "self", title: "Revised", body: "Revised plan" },
        actions: [next],
      })

      expect((await SessionTask.scope(session.id)).map((item) => item.session_id)).toEqual([oldSession.id])
    }))

  test("allows only controlled revision tools while revising without mutating the old workflow", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.route({
        sessionID: session.id,
        runID: "run_controlled_seed",
        legacy: { title: "Original", body: "Original" },
        actions: [{ id: "old" }],
      })
      if (first.type !== "execute") throw new Error("task missing")
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_controlled_update",
        assignment: { op: "update", target: "self", title: "Revised", body: "Revised" },
        actions: [{ id: "new" }],
      })
      const controlled = await SessionTask.route({
        sessionID: session.id,
        runID: "run_controlled_tool",
        actions: [
          {
            id: "inspect",
            executor: { type: "tool", target: "task_inspect" },
            operation: "inspect",
          },
        ],
      })
      expect(controlled.type).toBe("execute")
      expect((await SessionTask.get(session.id))?.revision.workflow).toEqual(first.revision.workflow)
      await expect(
        SessionTask.route({
          sessionID: session.id,
          runID: "run_forbidden_tool",
          actions: [{ id: "read", executor: { type: "tool", target: "read" } }],
        }),
      ).rejects.toThrow("session_task_revision_frozen")
    }))

  test("aggregates real actions across registered runs without losing prior progress", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_multi_one",
        assignment: { op: "create", target: "self", title: "Multi run", body: "Approved task" },
        actions: [{ id: "first", title: "First action" }],
      })
      await Storage.write(
        ["session_protocol_run", session.id, "run_multi_one"],
        result("run_multi_one", [{ id: "first", title: "First action", status: "completed" }]),
      )
      await SessionTask.sync({ sessionID: session.id, runID: "run_multi_one" })
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_multi_two",
        actions: [
          { id: "first", title: "Tampered planned duplicate" },
          { id: "second", title: "Second action" },
        ],
      })
      await Storage.write(
        ["session_protocol_run", session.id, "run_multi_two"],
        result("run_multi_two", [
          { id: "first", title: "Second run first action", status: "completed" },
          { id: "second", title: "Second action", status: "completed" },
        ]),
      )
      await SessionTask.sync({ sessionID: session.id, runID: "run_multi_two" })
      await SessionTask.sync({ sessionID: session.id, runID: "run_multi_one" })

      const current = await SessionTask.current(session.id)
      expect(current?.actions.map((item) => [item.run_id, item.id, item.title, item.status])).toEqual([
        ["run_multi_one", "first", "First action", "completed"],
        ["run_multi_two", "first", "Second run first action", "completed"],
        ["run_multi_two", "second", "Second action", "completed"],
      ])
      expect(current?.progress).toEqual({ completed: 3, total: 3 })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({
        run_id: "run_multi_two",
        run_ids: ["run_multi_one", "run_multi_two"],
      })
    }))

  test("projects only the latest fifty runs with their matching action identities", () =>
    setup(async () => {
      const session = await Session.create({})
      for (const index of Array.from({ length: 55 }, (_, index) => index)) {
        const run = `run_window_${index.toString().padStart(2, "0")}`
        const action = `action_${index.toString().padStart(2, "0")}`
        await SessionTask.route({
          sessionID: session.id,
          runID: run,
          ...(index === 0
            ? { assignment: { op: "create" as const, target: "self" as const, title: "Window", body: "Window" } }
            : {}),
          actions: [{ id: action, title: action }],
        })
        await Storage.write(
          ["session_protocol_run", session.id, run],
          result(run, [{ id: action, title: action, status: "completed" }]),
        )
      }

      const current = await SessionTask.current(session.id)
      expect(current?.actions).toHaveLength(50)
      expect(current?.actions.map((item) => [item.run_id, item.id])).toEqual(
        Array.from({ length: 50 }, (_, offset) => {
          const index = offset + 5
          const suffix = index.toString().padStart(2, "0")
          return [`run_window_${suffix}`, `action_${suffix}`]
        }),
      )
      expect(current?.progress).toEqual({ completed: 50, total: 55 })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({
        compact: { runs: 5, completed: 0, total: 5 },
      })
      expect((await SessionTask.get(session.id))?.revision.workflow.actions).toHaveLength(50)
    }))

  test("bounds the persisted workflow while preserving compacted total progress", () =>
    setup(async () => {
      const session = await Session.create({})
      let size = 0
      for (const index of Array.from({ length: 200 }, (_, index) => index)) {
        const suffix = index.toString().padStart(3, "0")
        const run = `run_bound_${suffix}`
        const action = `action_bound_${suffix}`
        await SessionTask.route({
          sessionID: session.id,
          runID: run,
          ...(index === 0
            ? { assignment: { op: "create" as const, target: "self" as const, title: "Bound", body: "Bound" } }
            : {}),
          actions: [{ id: action, title: action }],
        })
        await SessionTask.sync({
          sessionID: session.id,
          runID: run,
          actions: result(run, [{ id: action, title: action, status: "completed" }]).actions,
        })
        if (index === 149) size = JSON.stringify((await SessionTask.get(session.id))?.revision.workflow).length
      }

      const stored = (await SessionTask.get(session.id))?.revision.workflow
      expect(stored?.run_ids).toHaveLength(50)
      expect(stored?.actions).toHaveLength(50)
      expect(stored).toMatchObject({ compact: { runs: 150, completed: 150, total: 150 } })
      expect(JSON.stringify(stored).length - size).toBeLessThan(100)
      expect((await SessionTask.current(session.id))?.progress).toEqual({ completed: 200, total: 200 })
      await expect(
        SessionTask.sync({
          sessionID: session.id,
          runID: "run_bound_000",
          actions: result("run_bound_000", [{ id: "action_bound_000", title: "action_bound_000", status: "completed" }])
            .actions,
        }),
      ).rejects.toThrow("session_task_stale_run")
    }))

  test("strictly parses workflow run ids and task action identities", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_schema",
        assignment: { op: "create", target: "self", title: "Schema task", body: "Schema body" },
        actions: [{ id: "schema", title: "Schema action" }],
      })
      await Storage.write(
        ["session_protocol_run", session.id, "run_schema"],
        result("run_schema", [{ id: "schema", title: "Schema action", status: "completed" }]),
      )
      await SessionTask.sync({ sessionID: session.id, runID: "run_schema" })
      const revision = await SessionTask.revision(session.id, 1)
      expect(SessionTask.RevisionView.safeParse(revision).success).toBe(true)
      expect(revision?.workflow.run_ids).toEqual(["run_schema"])
      expect(revision?.actions[0]).toMatchObject({ run_id: "run_schema", id: "schema" })
    }))

  test("sync upgrades planned actions once and rejects divergent replays", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_sync_cas",
        assignment: { op: "create", target: "self", title: "Sync CAS", body: "Sync CAS" },
        actions: [{ id: "write", title: "Write" }],
      })
      const action = result("run_sync_cas", [{ id: "write", title: "Write", status: "completed" }]).actions[0]!
      await SessionTask.sync({ sessionID: session.id, runID: "run_sync_cas", actions: [action] })
      const saved = JSON.stringify(await SessionTask.get(session.id))

      await SessionTask.sync({ sessionID: session.id, runID: "run_sync_cas", actions: [action] })
      expect(JSON.stringify(await SessionTask.get(session.id))).toBe(saved)
      await expect(
        SessionTask.sync({
          sessionID: session.id,
          runID: "run_sync_cas",
          actions: [{ ...action, output: "Divergent replay" }],
        }),
      ).rejects.toThrow("session_task_action_conflict")
      await expect(
        SessionTask.sync({
          sessionID: session.id,
          runID: "run_sync_cas",
          actions: [{ id: "write", title: "Planned replay" } as never],
        }),
      ).rejects.toThrow("session_task_action_conflict")
      expect(JSON.stringify(await SessionTask.get(session.id))).toBe(saved)
    }))

  test("rejects late sync after the task or current revision becomes terminal", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_sync_done",
        assignment: { op: "create", target: "self", title: "Done", body: "Done" },
        actions: [{ id: "done", title: "Done" }],
      })
      await SessionTask.finish({
        sessionID: session.id,
        runID: "run_sync_done",
        summary: "Done",
        source: "protocol",
      })
      const completed = JSON.stringify(await SessionTask.get(session.id))
      await expect(
        SessionTask.sync({
          sessionID: session.id,
          runID: "run_sync_done",
          actions: result("run_sync_done", [{ id: "done", title: "Done", status: "completed" }]).actions,
        }),
      ).rejects.toThrow("session_task_stale_run")
      expect(JSON.stringify(await SessionTask.get(session.id))).toBe(completed)

      const archived = await Session.create({})
      const bound = await SessionTask.route({
        sessionID: archived.id,
        runID: "run_sync_archived",
        assignment: { op: "create", target: "self", title: "Archived", body: "Archived" },
        actions: [{ id: "archived", title: "Archived" }],
      })
      if (bound.type !== "execute") throw new Error("task binding missing")
      Database.transaction((tx) => {
        tx.update(TaskRevisionTable)
          .set({ status: "archived" })
          .where(eq(TaskRevisionTable.id, bound.revision.id))
          .run()
        tx.update(SessionTaskTable).set({ status: "failed" }).where(eq(SessionTaskTable.id, bound.task.id)).run()
      })
      const terminal = JSON.stringify(await SessionTask.get(archived.id))
      await expect(
        SessionTask.sync({
          sessionID: archived.id,
          runID: "run_sync_archived",
          actions: result("run_sync_archived", [{ id: "archived", title: "Archived", status: "completed" }]).actions,
        }),
      ).rejects.toThrow("session_task_stale_run")
      expect(JSON.stringify(await SessionTask.get(archived.id))).toBe(terminal)
    }))

  test("binds only canonical confirmed assignment content after parsed action tampering", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = {
        type: "action",
        id: "confirm_canonical",
        title: "Canonical title",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: {
          prompt: "Confirm canonical plan",
          plan: "Canonical approved plan",
          assignment: { op: "create", target: "self" },
        },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Canonical approved plan",
        runID: "run_canonical",
        sessionID: session.id,
      })
      action.title = "Tampered title"
      action.input = { ...action.input, plan: "Tampered plan", assignment: { op: "handoff", target: "peer" } }
      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_wrong_source",
          actionIDs: [action.id],
          actions: [action],
          legacy: { title: action.title, body: "Tampered legacy body" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_source_conflict")
      await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_canonical",
        actionIDs: [action.id],
        actions: [action],
        legacy: { title: action.title, body: "Tampered legacy body" },
        requiresAssignment: true,
      })

      expect(await SessionTask.current(session.id)).toMatchObject({
        title: "Canonical title",
        body: "Canonical approved plan",
      })
    }))

  test("keeps concurrent assignment row and canonical blob content consistent", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = (id: string, title: string) =>
        ({
          type: "action",
          id,
          title,
          operation: "confirm",
          executor: { type: "human", target: "user", capabilities: ["confirmation"] },
          input: { assignment: { op: "update", target: "self" } },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        }) as AgentProtocol.Action
      const initial = await SessionAssignment.confirm({
        action: { ...action("initial", "Initial"), input: { assignment: { op: "create", target: "self" } } },
        messageID: MessageID.ascending(),
        plan: "Initial plan",
        runID: "run_initial",
        sessionID: session.id,
      })
      if (!initial) throw new Error("initial assignment missing")
      let release = () => {}
      let written = () => {}
      const hold = new Promise<void>((resolve) => (release = resolve))
      const ready = new Promise<void>((resolve) => (written = resolve))
      const write = Storage.write
      const hook = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        const body = value as { plan?: string }
        if (body.plan === "Plan A") {
          const saved = await write(key, value)
          written()
          await hold
          return saved
        }
        if (body.plan === "Plan B") await ready
        return write(key, value)
      })
      try {
        const first = SessionAssignment.confirm({
          action: action("update_a", "Plan A"),
          messageID: MessageID.ascending(),
          plan: "Plan A",
          runID: "run_update_a",
          sessionID: session.id,
        })
        await ready
        const second = SessionAssignment.confirm({
          action: action("update_b", "Plan B"),
          messageID: MessageID.ascending(),
          plan: "Plan B",
          runID: "run_update_b",
          sessionID: session.id,
        })
        await until(async () => (await SessionAssignment.get(initial.id))?.title === "Plan B")
        release()
        await Promise.allSettled([first, second])
      } finally {
        hook.mockRestore()
        release()
      }

      const saved = await SessionAssignment.get(initial.id)
      if (!saved) throw new Error("saved assignment missing")
      const content = (await SessionAssignment.content(saved.id)) as { plan?: string }
      expect(content.plan).toBe(saved.title)
    }))

  test("rejects confirmed binding when canonical assignment content is tampered", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = {
        type: "action",
        id: "confirm_tampered_blob",
        title: "Canonical title",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "create", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Canonical plan",
        runID: "run_tampered_blob",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      const content = (await SessionAssignment.content(assignment.id)) as Record<string, unknown>
      await Storage.write(assignment.content_ref.split("/"), {
        ...content,
        plan: "Tampered plan",
        assignment: { op: "handoff", target: "peer" },
      })

      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_tampered_blob",
          actionIDs: [action.id],
          actions: [],
          legacy: { title: "Legacy", body: "Legacy" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_content_invalid")
      expect(await SessionTask.get(session.id)).toBeUndefined()
    }))

  test("binds a legacy rev assignment as create only for a session without a task", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = {
        type: "action",
        id: "legacy_confirm",
        title: "Legacy canonical title",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "create", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Legacy canonical plan",
        runID: "run_legacy_confirm",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      await legacy({
        assignment,
        plan: "Legacy canonical plan",
        route: { op: "handoff", target: "peer" },
        source: { type: "confirm", session_id: session.id, run_id: "run_legacy_confirm", action_id: action.id },
      })

      await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_legacy_execute",
        actionIDs: [],
        actions: [{ id: "legacy_execute" }],
        legacy: { title: "Unsafe fallback", body: "Unsafe fallback" },
      })
      expect(await SessionTask.current(session.id)).toMatchObject({
        title: "Legacy canonical title",
        body: "Legacy canonical plan",
      })
    }))

  test("rejects a legacy rev confirm assignment when the session already has a task", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_existing",
        legacy: { title: "Existing", body: "Existing plan" },
        actions: [],
      })
      const action = {
        type: "action",
        id: "legacy_existing",
        title: "Legacy replacement",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "create", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Legacy replacement plan",
        runID: "run_legacy_existing",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      await legacy({
        assignment,
        plan: "Legacy replacement plan",
        source: { type: "confirm", session_id: session.id, run_id: "run_legacy_existing", action_id: action.id },
      })

      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_legacy_existing",
          actionIDs: [action.id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_content_invalid")
      expect(await SessionTask.current(session.id)).toMatchObject({ title: "Existing", body: "Existing plan" })
    }))

  test("binds a legacy rev delegated assignment by its source locator", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const action = {
        type: "action",
        id: "legacy_delegate",
        title: "Legacy delegated task",
        operation: "backend",
        executor: { type: "agent", target: "backend", capabilities: [] },
        input: {},
        depends_on: [],
        context_refs: [],
        result_policy: "structured",
      } as AgentProtocol.Action
      const messageID = MessageID.ascending()
      const assignment = await SessionAssignment.delegate({
        action,
        childID: child.id,
        messageID,
        plan: "Legacy delegated plan",
        runID: "run_legacy_delegate",
        sessionID: parent.id,
      })
      await legacy({
        assignment,
        plan: "Legacy delegated plan",
        source: { type: "delegation", session_id: parent.id, run_id: "run_legacy_delegate", action_id: action.id },
      })

      await SessionTask.beginDelegated({
        sessionID: child.id,
        parentSessionID: parent.id,
        parentRunID: "run_legacy_delegate",
        parentActionID: action.id,
        messageID,
      })
      expect(await SessionTask.get(child.id)).toMatchObject({
        task: {
          source_type: "delegation",
          source_ref: { sessionID: parent.id, runID: "run_legacy_delegate", actionID: action.id },
        },
        revision: { title: "Legacy delegated task", body: "Legacy delegated plan" },
      })
    }))

  test("rejects a tampered legacy rev assignment plan", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = {
        type: "action",
        id: "legacy_tampered",
        title: "Legacy tampered",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "create", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Trusted legacy plan",
        runID: "run_legacy_tampered",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      await legacy({
        assignment,
        plan: "Trusted legacy plan",
        stored: "Tampered legacy plan",
        source: { type: "confirm", session_id: session.id, run_id: "run_legacy_tampered", action_id: action.id },
      })

      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_legacy_tampered",
          actionIDs: [action.id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_content_invalid")
      expect(await SessionTask.get(session.id)).toBeUndefined()
    }))

  test("rejects a superseded confirmed assignment identity", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = (id: string) =>
        ({
          type: "action",
          id,
          title: id,
          operation: "confirm",
          executor: { type: "human", target: "user", capabilities: ["confirmation"] },
          input: { plan: id, assignment: { op: "create", target: "self" } },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        }) as AgentProtocol.Action
      await SessionAssignment.confirm({
        action: action("old_confirm"),
        messageID: MessageID.ascending(),
        plan: "Old plan",
        runID: "run_old_confirm",
        sessionID: session.id,
      })
      await SessionAssignment.confirm({
        action: action("new_confirm"),
        messageID: MessageID.ascending(),
        plan: "New plan",
        runID: "run_new_confirm",
        sessionID: session.id,
      })
      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_old_confirm",
          actionIDs: ["old_confirm"],
          actions: [],
          legacy: { title: "Old", body: "Old" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_not_current")
    }))

  test("binds a later executable run from the current confirm-only assignment", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = (id: string, title: string) =>
        ({
          type: "action",
          id,
          title,
          operation: "confirm",
          executor: { type: "human", target: "user", capabilities: ["confirmation"] },
          input: { assignment: { op: "create", target: "self" } },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        }) as AgentProtocol.Action
      await SessionAssignment.confirm({
        action: action("old_confirm_only", "Old assignment"),
        messageID: MessageID.ascending(),
        plan: "Old plan",
        runID: "run_old_confirm_only",
        sessionID: session.id,
      })
      const assignment = await SessionAssignment.confirm({
        action: action("current_confirm_only", "Approved assignment"),
        messageID: MessageID.ascending(),
        plan: "Approved canonical plan",
        runID: "run_confirm_only",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")

      await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_execute_later",
        actionIDs: [],
        actions: [{ id: "execute_later", title: "Execute later" }],
        legacy: { title: "Legacy fallback", body: "Legacy fallback" },
      })
      expect(await SessionTask.current(session.id)).toMatchObject({
        title: "Approved assignment",
        body: "Approved canonical plan",
      })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({ actions: [] })
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_formal_execution",
        legacy: { title: "Ignored", body: "Ignored" },
        actions: [{ id: "formal_execution", title: "Formal execution" }],
      })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({
        run_id: "run_formal_execution",
        run_ids: ["run_formal_execution"],
      })
      expect((await SessionAssignment.get(assignment.id))?.status).toBe("completed")
      const bound = await SessionTask.get(session.id)
      expect(bound?.revision.workflow.assignment_id).toBe(assignment.id)
      const replay = await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_confirm_only",
        actionIDs: ["current_confirm_only"],
        actions: [],
        legacy: { title: "Unsafe", body: "Unsafe" },
        requiresAssignment: true,
      })
      expect(replay.type).toBe("replay")
      expect((await SessionTask.get(session.id))?.revision.id).toBe(bound?.revision.id)

      await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_execute_again",
        actionIDs: [],
        actions: [{ id: "execute_again" }],
        legacy: { title: "Unsafe", body: "Unsafe" },
      })
      await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_execute_third",
        actionIDs: [],
        actions: [{ id: "execute_third" }],
        legacy: { title: "Unsafe", body: "Unsafe" },
      })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({
        run_id: "run_execute_third",
        run_ids: ["run_formal_execution", "run_execute_again", "run_execute_third"],
      })
    }))

  test("consumes an update assignment only after its draft is created", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_seed_update",
        legacy: { title: "Seed", body: "Seed plan" },
        actions: [],
      })
      const action = {
        type: "action",
        id: "confirm_update_consumed",
        title: "Updated task",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "update", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Updated plan",
        runID: "run_confirm_update_consumed",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")

      const result = await SessionTask.confirmed({
        sessionID: session.id,
        runID: "run_confirm_update_consumed",
        actionIDs: [action.id],
        actions: [],
        legacy: { title: "Unsafe", body: "Unsafe" },
        requiresAssignment: true,
      })
      expect(result.type).toBe("update")
      expect((await SessionAssignment.get(assignment.id))?.status).toBe("completed")
      if (result.type !== "update") throw new Error("update missing")
      expect(result.revision.workflow.assignment_id).toBe(assignment.id)
      const flow = { ...result.revision.workflow }
      delete flow.assignment_id
      Database.use((tx) =>
        tx.update(TaskRevisionTable).set({ workflow: flow }).where(eq(TaskRevisionTable.id, result.revision.id)).run(),
      )
      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_confirm_update_consumed",
          actionIDs: [action.id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_not_current")
    }))

  test("replays identical update drafts by their exact assignment identity", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_seed_identity",
        legacy: { title: "Seed", body: "Seed plan" },
        actions: [],
      })
      const action = (id: string) =>
        ({
          type: "action",
          id,
          title: "Identical update",
          operation: "confirm",
          executor: { type: "human", target: "user", capabilities: ["confirmation"] },
          input: { assignment: { op: "update", target: "self" } },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        }) as AgentProtocol.Action
      const confirm = async (id: string, run: string) => {
        const item = action(id)
        const assignment = await SessionAssignment.confirm({
          action: item,
          messageID: MessageID.ascending(),
          plan: "Identical plan",
          runID: run,
          sessionID: session.id,
        })
        if (!assignment) throw new Error("assignment missing")
        const result = await SessionTask.confirmed({
          sessionID: session.id,
          runID: run,
          actionIDs: [id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        })
        if (result.type !== "update") throw new Error("update missing")
        return { assignment, result }
      }
      const first = await confirm("confirm_identity_first", "run_identity_first")
      await expect(confirm("confirm_identity_second", "run_identity_second")).rejects.toThrow(
        "session_task_update_in_progress",
      )

      const replay = async (id: string, run: string) =>
        SessionTask.confirmed({
          sessionID: session.id,
          runID: run,
          actionIDs: [id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        })
      const old = await replay("confirm_identity_first", "run_identity_first")
      const again = await replay("confirm_identity_first", "run_identity_first")

      expect(first.result.revision.workflow.assignment_id).toBe(first.assignment.id)
      expect(old.type === "replay" ? old.revision.id : undefined).toBe(first.result.revision.id)
      expect(again.type === "replay" ? again.revision.id : undefined).toBe(first.result.revision.id)
      expect(await SessionTask.revision(session.id, 3)).toBeUndefined()

      Database.use((tx) =>
        [first.result.revision].forEach((revision) => {
          const flow = { ...revision.workflow }
          delete flow.assignment_id
          flow.run_id = "run_identity_first"
          flow.run_ids = ["run_identity_first"]
          tx.update(TaskRevisionTable).set({ workflow: flow }).where(eq(TaskRevisionTable.id, revision.id)).run()
        }),
      )
      await expect(replay("confirm_identity_first", "run_identity_first")).rejects.toThrow(
        "session_task_assignment_not_current",
      )
    }))

  test("replays create and update assignments from their original revisions without changing current", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = (id: string, op: "create" | "update", title: string) =>
        ({
          type: "action",
          id,
          title,
          operation: "confirm",
          executor: { type: "human", target: "user", capabilities: ["confirmation"] },
          input: { assignment: { op, target: "self" } },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        }) as AgentProtocol.Action
      const confirm = async (item: AgentProtocol.Action, run: string, plan: string) => {
        const assignment = await SessionAssignment.confirm({
          action: item,
          messageID: MessageID.ascending(),
          plan,
          runID: run,
          sessionID: session.id,
        })
        if (!assignment) throw new Error("assignment missing")
        const result = await SessionTask.confirmed({
          sessionID: session.id,
          runID: run,
          actionIDs: [item.id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        })
        return { assignment, result }
      }
      const create = action("confirm_create_history", "create", "Original task")
      const first = await confirm(create, "run_create_history", "Original plan")
      if (first.result.type !== "execute") throw new Error("create missing")
      const update = action("confirm_update_history", "update", "Revised task")
      const second = await confirm(update, "run_update_history", "Revised plan")
      if (second.result.type !== "update") throw new Error("update missing")
      await SessionTask.activate({ taskID: second.result.task.id, revisionID: second.result.revision.id })

      const replay = (item: AgentProtocol.Action, run: string) =>
        SessionTask.confirmed({
          sessionID: session.id,
          runID: run,
          actionIDs: [item.id],
          actions: [{ id: "must_not_execute" }],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        })
      const old = await replay(create, "run_create_history")
      const current = await replay(update, "run_update_history")

      expect(old.type).toBe("replay")
      if (old.type !== "replay") throw new Error("create replay missing")
      expect(old.revision.id).toBe(first.result.revision.id)
      expect(current.type).toBe("replay")
      if (current.type !== "replay") throw new Error("update replay missing")
      expect(current.revision.id).toBe(second.result.revision.id)
      expect(old.revision.workflow.actions).not.toContainEqual({ id: "must_not_execute" })
      expect(current.revision.workflow.actions).not.toContainEqual({ id: "must_not_execute" })
      expect((await SessionTask.get(session.id))?.revision.id).toBe(second.result.revision.id)
      expect(await SessionTask.revision(session.id, 3)).toBeUndefined()

      const other = await Session.create({})
      const foreign = await SessionTask.route({
        sessionID: other.id,
        runID: "run_foreign_task",
        legacy: { title: "Foreign task", body: "Foreign plan" },
        actions: [],
      })
      if (foreign.type !== "execute") throw new Error("foreign task missing")
      Database.use((tx) =>
        tx
          .update(TaskRevisionTable)
          .set({ workflow: { ...foreign.revision.workflow, assignment_id: first.assignment.id } })
          .where(eq(TaskRevisionTable.id, foreign.revision.id))
          .run(),
      )
      await expect(
        SessionTask.confirmed({
          sessionID: other.id,
          runID: "run_create_history",
          actionIDs: [create.id],
          actions: [],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_source_conflict")
      expect((await SessionTask.get(other.id))?.revision.id).toBe(foreign.revision.id)
    }))

  test("keeps handoff assignment pending and rejects ordinary execution", () =>
    setup(async () => {
      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_seed_handoff",
        legacy: { title: "Seed", body: "Seed plan" },
        actions: [],
      })
      const action = {
        type: "action",
        id: "confirm_handoff_pending",
        title: "Peer task",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "handoff", target: "peer" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Peer plan",
        runID: "run_confirm_handoff_pending",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      expect(
        (
          await SessionTask.confirmed({
            sessionID: session.id,
            runID: "run_confirm_handoff_pending",
            actionIDs: [action.id],
            actions: [],
            legacy: { title: "Unsafe", body: "Unsafe" },
            requiresAssignment: true,
          })
        ).type,
      ).toBe("handoff")
      expect((await SessionAssignment.get(assignment.id))?.status).toBe("running")
      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_execute_while_handoff_pending",
          actionIDs: [],
          actions: [{ id: "unsafe_execute" }],
          legacy: { title: "Unsafe", body: "Unsafe" },
        }),
      ).rejects.toThrow("session_task_handoff_pending")
      expect((await SessionAssignment.get(assignment.id))?.status).toBe("running")
    }))

  test("rejects confirm-only inheritance when more than one assignment is active", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = (id: string) =>
        ({
          type: "action",
          id,
          title: id,
          operation: "confirm",
          executor: { type: "human", target: "user", capabilities: ["confirmation"] },
          input: { assignment: { op: "create", target: "self" } },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        }) as AgentProtocol.Action
      const first = await SessionAssignment.confirm({
        action: action("ambiguous_one"),
        messageID: MessageID.ascending(),
        plan: "One",
        runID: "run_ambiguous_one",
        sessionID: session.id,
      })
      await SessionAssignment.confirm({
        action: action("ambiguous_two"),
        messageID: MessageID.ascending(),
        plan: "Two",
        runID: "run_ambiguous_two",
        sessionID: session.id,
      })
      if (!first) throw new Error("assignment missing")
      Database.use((tx) =>
        tx.update(AssignmentTable).set({ status: "running" }).where(eq(AssignmentTable.id, first.id)).run(),
      )

      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_ambiguous_execute",
          actionIDs: [],
          actions: [{ id: "execute" }],
          legacy: { title: "Legacy", body: "Legacy" },
        }),
      ).rejects.toThrow("session_task_assignment_source_conflict")
      expect(await SessionTask.get(session.id)).toBeUndefined()
    }))

  test("rolls back confirmed binding when its assignment is superseded during task insert", () =>
    setup(async () => {
      const session = await Session.create({})
      const action = {
        type: "action",
        id: "confirm_race",
        title: "Canonical race",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "create", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Canonical race plan",
        runID: "run_confirm_race",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      Database.Client().run(
        sql.raw(`
          CREATE TEMP TRIGGER supersede_confirm_before_task
          BEFORE INSERT ON session_task
          BEGIN
            UPDATE assignment SET status = 'superseded' WHERE id = '${assignment.id}';
          END
        `),
      )

      await expect(
        SessionTask.confirmed({
          sessionID: session.id,
          runID: "run_confirm_race",
          actionIDs: [action.id],
          actions: [action],
          legacy: { title: "Untrusted", body: "Untrusted" },
          requiresAssignment: true,
        }),
      ).rejects.toThrow("session_task_assignment_not_current")
      expect(await SessionTask.get(session.id)).toBeUndefined()
    }))

  test("rolls back delegated binding when its assignment is superseded during task insert", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const action = {
        type: "action",
        id: "delegate_race",
        title: "Delegated race",
        operation: "agent",
        executor: { type: "agent", target: "worker", capabilities: [] },
        input: { prompt: "Delegated race plan" },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const assignment = await SessionAssignment.delegate({
        action,
        childID: child.id,
        messageID: MessageID.ascending(),
        plan: "Delegated race plan",
        runID: "run_delegate_race",
        sessionID: parent.id,
      })
      if (!assignment) throw new Error("assignment missing")
      Database.Client().run(
        sql.raw(`
          CREATE TEMP TRIGGER supersede_delegate_before_task
          BEFORE INSERT ON session_task
          BEGIN
            UPDATE assignment SET status = 'superseded' WHERE id = '${assignment.id}';
          END
        `),
      )

      await expect(
        SessionTask.beginDelegated({
          sessionID: child.id,
          parentSessionID: parent.id,
          parentRunID: "run_delegate_race",
          parentActionID: action.id,
          messageID: MessageID.ascending(),
        }),
      ).rejects.toThrow("session_task_delegation_assignment_missing")
      expect(await SessionTask.get(child.id)).toBeUndefined()
    }))

  test("derives delegated task content from the canonical assignment locator", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const action = {
        type: "action",
        id: "delegate_locator",
        title: "Canonical delegated title",
        operation: "agent",
        executor: { type: "agent", target: "worker", capabilities: [] },
        input: { prompt: "Untrusted declaration body" },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      await SessionAssignment.delegate({
        action,
        childID: child.id,
        messageID: MessageID.ascending(),
        plan: "Canonical delegated plan",
        runID: "run_delegate_locator",
        sessionID: parent.id,
      })

      await SessionTask.beginDelegated({
        sessionID: child.id,
        parentSessionID: parent.id,
        parentRunID: "run_delegate_locator",
        parentActionID: action.id,
        messageID: MessageID.ascending(),
      })
      expect(await SessionTask.current(child.id)).toMatchObject({
        title: "Canonical delegated title",
        body: "Canonical delegated plan",
      })
    }))

  test("delegated task rejects local protocol completion as its canonical result", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      await SessionAssignment.delegate({
        action: {
          type: "action",
          id: "delegate_source",
          title: "Delegated task",
          operation: "agent",
          executor: { type: "agent", target: "worker", capabilities: [] },
          input: { prompt: "Delegation plan" },
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        } as AgentProtocol.Action,
        childID: child.id,
        messageID: MessageID.ascending(),
        plan: "Delegation plan",
        runID: "run_parent_source",
        sessionID: parent.id,
      })
      await SessionTask.beginDelegated({
        sessionID: child.id,
        parentSessionID: parent.id,
        parentRunID: "run_parent_source",
        parentActionID: "delegate_source",
      })
      await SessionTask.route({
        sessionID: child.id,
        runID: "run_child_local",
        actions: [{ id: "local", title: "Local action" }],
      })
      await Storage.write(
        ["session_protocol_run", child.id, "run_child_local"],
        result("run_child_local", [{ id: "local", title: "Local action", status: "completed" }]),
      )
      await SessionTask.sync({ sessionID: child.id, runID: "run_child_local" })
      await expect(
        SessionTask.finish({
          sessionID: child.id,
          runID: "run_child_local",
          summary: "Untrusted local protocol summary",
          source: "protocol",
        }),
      ).rejects.toThrow("session_task_delegated_protocol_result")
      expect(await SessionTask.current(child.id)).not.toHaveProperty("result")
      expect((await SessionTask.get(child.id))?.task.source_ref).toMatchObject({
        runID: "run_parent_source",
        actionID: "delegate_source",
      })
    }))

  test("creates one task per session", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Build task view",
        body: "# Build task view\n",
        source: { type: "user", messageID: MessageID.ascending() },
      })

      expect(first.revision.version).toBe(1)
      expect(first.revision.status).toBe("active")
      await expect(
        SessionTask.create({
          sessionID: session.id,
          title: "Second task",
          body: "# Second task\n",
          source: { type: "user", messageID: MessageID.ascending() },
        }),
      ).rejects.toBeInstanceOf(SessionTask.Conflict)
    }))

  test("advances one active revision and archives the old revision", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Build task view",
        body: "# Build task view\n",
        source: { type: "user", messageID: MessageID.ascending() },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Build the unified task view",
        body: "# Build task view\n\nUpdated scope.\n",
        reason: "User changed scope",
        messageID: MessageID.ascending(),
      })

      expect(draft.version).toBe(2)
      expect(draft.status).toBe("draft")
      expect(() =>
        Database.use((db) =>
          db.update(TaskRevisionTable).set({ status: "active" }).where(eq(TaskRevisionTable.id, draft.id)).run(),
        ),
      ).toThrow("UNIQUE constraint failed")
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })

      expect((await SessionTask.get(session.id))?.revision.version).toBe(2)
      expect((await SessionTask.history(session.id)).map((item) => item.status)).toEqual(["archived"])
    }))

  test("rejects a stale draft after another draft becomes active", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Initial task",
        body: "# Initial task\n",
        source: { type: "user", messageID: MessageID.ascending() },
      })
      const second = await SessionTask.draft({
        taskID: first.task.id,
        title: "Second revision",
        body: "# Second revision\n",
        messageID: MessageID.ascending(),
      })
      const stale = await SessionTask.draft({
        taskID: first.task.id,
        title: "Stale revision",
        body: "# Stale revision\n",
        messageID: MessageID.ascending(),
      })

      await SessionTask.activate({ taskID: first.task.id, revisionID: second.id })
      await expect(SessionTask.activate({ taskID: first.task.id, revisionID: stale.id })).rejects.toBeInstanceOf(
        SessionTask.Conflict,
      )
      expect((await SessionTask.get(session.id))?.revision.version).toBe(2)
    }))

  test("dual-writes one immutable Requirement across replayed draft and activation", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Ledger revision",
        body: "# Ledger revision\n",
        source: { type: "user", messageID: MessageID.ascending() },
      })
      const original = TaskLedger.requirements(first.task.id)[0]!
      const messageID = MessageID.ascending()
      const input = {
        taskID: first.task.id,
        title: "Ledger revision v2",
        body: "# Ledger revision\n\nUpdated.\n",
        reason: "Confirmed update",
        messageID,
      }
      const [draft, replay] = await Promise.all([SessionTask.draft(input), SessionTask.draft(input)])
      const requirements = TaskLedger.requirements(first.task.id)

      expect(replay.id).toBe(draft.id)
      expect(requirements.map((item) => item.version)).toEqual([1, 2])
      expect(requirements[0]).toEqual(original)
      expect(requirements[1]).toMatchObject({
        supersedes_id: original.id,
        source_refs: [`message:${messageID}`],
        body_ref: `task://${first.task.id}/revision/${draft.id}`,
        created_by: "user",
      })
      expect((await SessionTask.get(session.id))?.task.requirement_id).toBe(original.id)
      expect(draft).toMatchObject({
        requirement_id: requirements[1]!.id,
        spec_ref: `task://${first.task.id}/revision/${draft.id}`,
        plan_ref: null,
      })
      expect(TaskLedger.listEvents(first.task.id).map((item) => item.type)).toEqual([
        "task.created",
        "requirement.recorded",
        "revision.activated",
        "requirement.revised",
        "revision.created",
        "revision.drafted",
      ])
      await expect(SessionTask.draft({ ...input, body: "Drifted body" })).rejects.toThrow(
        "task_revision_command_drift",
      )
      expect(TaskLedger.requirements(first.task.id)).toHaveLength(2)
      expect(TaskLedger.listEvents(first.task.id)).toHaveLength(6)

      const [active, repeated] = await Promise.all([
        SessionTask.activate({ taskID: first.task.id, revisionID: draft.id }),
        SessionTask.activate({ taskID: first.task.id, revisionID: draft.id }),
      ])
      const current = await SessionTask.get(session.id)
      const resources = TaskLedger.listResources(first.task.id)

      expect(repeated.id).toBe(active.id)
      expect(current?.task).toMatchObject({
        current_revision_id: draft.id,
        requirement_id: requirements[1]!.id,
        last_event_seq: 8,
      })
      expect(current?.revision.id).toBe(draft.id)
      expect(TaskLedger.requirements(first.task.id)[0]).toEqual(original)
      expect(resources.filter((item) => item.revision_id === first.revision.id).map((item) => item.lifecycle)).toEqual([
        "archived",
      ])
      expect(resources.filter((item) => item.revision_id === draft.id).map((item) => item.lifecycle)).toEqual(["active"])
      expect(TaskLedger.listEvents(first.task.id).map((item) => item.type)).toEqual([
        "task.created",
        "requirement.recorded",
        "revision.activated",
        "requirement.revised",
        "revision.created",
        "revision.drafted",
        "revision.archived",
        "revision.activated",
      ])
      expect(TaskLedger.findCommand(`task.revise:message:${first.task.id}:${messageID}`)?.status).toBe("applied")
      expect(TaskLedger.findCommand(`revision.activate:${first.task.id}:${draft.id}`)?.status).toBe("applied")
    }))

  test("uses the confirmed update assignment as the Requirement and plan Resource", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Assignment revision",
        body: "Assignment revision v1",
        source: { type: "user", messageID: MessageID.ascending() },
      })
      const action = {
        type: "action",
        id: "confirm_ledger_update",
        title: "Assignment revision v2",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "update", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      const messageID = MessageID.ascending()
      const assignment = await SessionAssignment.confirm({
        action,
        messageID,
        plan: "Assignment revision v2 body",
        runID: "run_ledger_update",
        sessionID: session.id,
      })
      if (!assignment) throw new Error("assignment missing")
      const input = {
        sessionID: session.id,
        runID: "run_ledger_update",
        actionIDs: [action.id],
        messageID,
        actions: [],
        legacy: { title: "Legacy", body: "Legacy" },
        requiresAssignment: true,
      }
      const saved = await SessionTask.confirmed(input)
      const replay = await SessionTask.confirmed(input)
      if (!saved.revision || !replay.revision) throw new Error("revision missing")
      const requirement = TaskLedger.requirements(first.task.id)[1]!
      const plan = TaskLedger.listResources(first.task.id).find(
        (item) => item.revision_id === saved.revision.id && item.kind === "plan",
      )

      expect(saved.type).toBe("update")
      expect(replay.type).toBe("replay")
      expect(replay.revision.id).toBe(saved.revision.id)
      expect(requirement).toMatchObject({
        body_ref: assignment.content_ref,
        body_hash: assignment.content_hash,
        supersedes_id: first.task.requirement_id,
        source_refs: [
          `assignment:${assignment.id}`,
          `session:${session.id}`,
          `message:${messageID}`,
          "run:run_ledger_update",
          `action:${action.id}`,
        ],
      })
      expect(plan).toMatchObject({
        uri: assignment.content_ref,
        hash: assignment.content_hash,
        producer_id: assignment.id,
      })
      expect(saved.revision.plan_ref).toBe(assignment.content_ref)
      expect(TaskLedger.findCommand(`task.revise:assignment:${assignment.id}`)?.status).toBe("applied")
      expect(TaskLedger.listEvents(first.task.id)).toHaveLength(6)
    }))

  test("keeps draft and activation ledger-free while the flag is off", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Flag off revision",
        body: "Flag off revision v1",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Flag off revision v2",
        body: "Flag off revision v2",
      })
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
      const current = await SessionTask.get(session.id)

      expect(current?.task).toMatchObject({ requirement_id: null, last_event_seq: 0 })
      expect(current?.revision).toMatchObject({ requirement_id: null, spec_ref: null, plan_ref: null })
      expect(TaskLedger.requirements(first.task.id)).toEqual([])
      expect(TaskLedger.listResources(first.task.id)).toEqual([])
      expect(TaskLedger.listEvents(first.task.id)).toEqual([])
    }))

  test("rejects a stale ledger draft without appending activation facts", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Stale ledger revision",
        body: "Stale ledger revision v1",
        source: { type: "user" },
      })
      const active = await SessionTask.draft({
        taskID: first.task.id,
        title: "Active ledger revision",
        body: "Active ledger revision",
        messageID: MessageID.ascending(),
      })
      const stale = await SessionTask.draft({
        taskID: first.task.id,
        title: "Stale ledger draft",
        body: "Stale ledger draft",
        messageID: MessageID.ascending(),
      })
      await SessionTask.activate({ taskID: first.task.id, revisionID: active.id })
      const count = TaskLedger.listEvents(first.task.id).length

      await expect(SessionTask.activate({ taskID: first.task.id, revisionID: stale.id })).rejects.toBeInstanceOf(
        SessionTask.Conflict,
      )
      expect(TaskLedger.listEvents(first.task.id)).toHaveLength(count)
      expect(TaskLedger.findCommand(`revision.activate:${first.task.id}:${stale.id}`)).toBeUndefined()
      expect((await SessionTask.get(session.id))?.revision.id).toBe(active.id)
    }))

  test("rejects a draft rebound to the old Requirement without mutating history", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Invalid Requirement",
        body: "Invalid Requirement v1",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Invalid Requirement v2",
        body: "Invalid Requirement v2",
      })
      Database.use((db) =>
        db
          .update(TaskRevisionTable)
          .set({ requirement_id: first.task.requirement_id })
          .where(eq(TaskRevisionTable.id, draft.id))
          .run(),
      )
      const before = TaskLedger.listEvents(first.task.id)

      await expect(SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })).rejects.toThrow(
        "task_revision_requirement_invalid",
      )
      expect(TaskLedger.listEvents(first.task.id)).toEqual(before)
      expect(TaskLedger.requirements(first.task.id)).toHaveLength(2)
      expect((await SessionTask.get(session.id))?.task.requirement_id).toBe(first.task.requirement_id)
      expect(TaskLedger.findCommand(`revision.activate:${first.task.id}:${draft.id}`)).toBeUndefined()
    }))

  test("rolls back Revision, Requirement and Resource activation when an Event fails", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Rollback revision",
        body: "Rollback revision v1",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Rollback revision v2",
        body: "Rollback revision v2",
      })
      Database.use((db) =>
        db.run(sql`
          CREATE TRIGGER fail_revision_activation_event
          BEFORE INSERT ON task_event
          WHEN NEW.type = 'revision.activated'
          BEGIN
            SELECT RAISE(ABORT, 'revision activation event failure');
          END
        `),
      )

      await expect(SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })).rejects.toThrow()
      const current = await SessionTask.get(session.id)
      const rows = Database.use((db) =>
        db
          .select()
          .from(TaskRevisionTable)
          .where(inArray(TaskRevisionTable.id, [first.revision.id, draft.id]))
          .all(),
      )

      expect(current?.task).toMatchObject({
        current_revision_id: first.revision.id,
        requirement_id: first.task.requirement_id,
        last_event_seq: 6,
      })
      expect(rows.find((item) => item.id === first.revision.id)?.status).toBe("active")
      expect(rows.find((item) => item.id === draft.id)?.status).toBe("draft")
      expect(TaskLedger.listResources(first.task.id).every((item) => item.lifecycle === "active")).toBe(true)
      expect(TaskLedger.listEvents(first.task.id)).toHaveLength(6)
      expect(TaskLedger.findCommand(`revision.activate:${first.task.id}:${draft.id}`)).toBeUndefined()
    }))

  test("records one recovery activation source across bootstrap replays", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Recovery revision",
        body: "Recovery revision v1",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Recovery revision v2",
        body: "Recovery revision v2",
      })
      const input = { taskID: first.task.id, revisionID: draft.id, bootstrap: true }
      const [active, replay] = await Promise.all([SessionTask.activate(input), SessionTask.activate(input)])
      const events = TaskLedger.listEvents(first.task.id)

      expect(replay.id).toBe(active.id)
      expect(events.slice(-2).map((item) => item.data)).toEqual([
        { activation_source: "recovery" },
        { activation_source: "recovery" },
      ])
      expect(events).toHaveLength(8)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(SessionEventOutboxTable)
            .where(eq(SessionEventOutboxTable.dedupe_key, `task_revision_bootstrap:${draft.id}`))
            .all(),
        ),
      ).toHaveLength(1)
    }))

  test("rolls back a drafted Requirement and Resource when its Event fails", () =>
    setup(async () => {
      // @ts-expect-error test-only flag override
      Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER = true
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Rollback draft",
        body: "Rollback draft v1",
        source: { type: "user" },
      })
      Database.use((db) =>
        db.run(sql`
          CREATE TRIGGER fail_revision_created_event
          BEFORE INSERT ON task_event
          WHEN NEW.type = 'revision.created'
          BEGIN
            SELECT RAISE(ABORT, 'revision created event failure');
          END
        `),
      )

      await expect(
        SessionTask.draft({
          taskID: first.task.id,
          title: "Rollback draft v2",
          body: "Rollback draft v2",
        }),
      ).rejects.toThrow()
      expect(TaskLedger.requirements(first.task.id)).toHaveLength(1)
      expect(TaskLedger.listResources(first.task.id)).toHaveLength(1)
      expect(TaskLedger.listEvents(first.task.id)).toHaveLength(3)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(TaskRevisionTable)
            .where(eq(TaskRevisionTable.task_id, first.task.id))
            .all(),
        ),
      ).toHaveLength(1)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, first.task.id))
            .get()?.requirement_id,
        ),
      ).toBe(first.task.requirement_id)
    }))

  test("rejects source ownership drift while retaining target handoff snapshots", () =>
    setup(async () => {
      const a = await Session.create({})
      const b = await Session.create({})
      const first = await SessionTask.create({
        sessionID: a.id,
        title: "First task",
        body: "# First task\n",
        source: { type: "user" },
      })
      const second = await SessionTask.create({
        sessionID: b.id,
        title: "Second task",
        body: "# Second task\n",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "First draft",
        body: "# First draft\n",
      })

      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRevisionTable)
            .set({ previous_id: "revision_missing" })
            .where(eq(TaskRevisionTable.id, draft.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRevisionTable)
            .set({ previous_id: second.revision.id })
            .where(eq(TaskRevisionTable.id, draft.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(SessionTaskTable)
            .set({ current_revision_id: second.revision.id })
            .where(eq(SessionTaskTable.id, first.task.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(SessionTaskTable)
            .set({ current_revision_id: "revision_missing" })
            .where(eq(SessionTaskTable.id, first.task.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .insert(TaskHandoffTable)
            .values({
              id: "handoff_source_mismatch",
              source_session_id: b.id,
              source_task_id: first.task.id,
              title: "Source mismatch",
              body: "# Source mismatch\n",
              body_hash: "0".repeat(64),
              context_refs: [],
              status: "proposed",
              dedupe_key: "source_mismatch",
              time_created: Date.now(),
            })
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .insert(TaskHandoffTable)
            .values({
              id: "handoff_target_mismatch",
              source_session_id: a.id,
              source_task_id: first.task.id,
              target_session_id: b.id,
              target_task_id: first.task.id,
              title: "Target mismatch",
              body: "# Target mismatch\n",
              body_hash: "0".repeat(64),
              context_refs: [],
              status: "proposed",
              dedupe_key: "target_mismatch",
              time_created: Date.now(),
            })
            .run(),
        ),
      ).not.toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .insert(TaskHandoffTable)
            .values({
              id: "handoff_target_missing",
              source_session_id: a.id,
              source_task_id: first.task.id,
              target_session_id: b.id,
              target_task_id: "task_missing",
              title: "Target missing",
              body: "# Target missing\n",
              body_hash: "0".repeat(64),
              context_refs: [],
              status: "proposed",
              dedupe_key: "target_missing",
              time_created: Date.now(),
            })
            .run(),
        ),
      ).not.toThrow()

      Database.use((db) =>
        db
          .delete(TaskHandoffTable)
          .where(inArray(TaskHandoffTable.id, ["handoff_target_mismatch", "handoff_target_missing"]))
          .run(),
      )
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
      await Session.remove(a.id)
      expect(await SessionTask.get(a.id)).toBeUndefined()
    }))

  test("keeps revision ids immutable", () =>
    setup(async () => {
      const session = await Session.create({})
      const task = await SessionTask.create({
        sessionID: session.id,
        title: "Stable revision ids",
        body: "# Stable revision ids\n",
        source: { type: "user" },
      })
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRevisionTable)
            .set({ id: "revision_renamed_current" })
            .where(eq(TaskRevisionTable.id, task.revision.id))
            .run(),
        ),
      ).toThrow()
      const draft = await SessionTask.draft({
        taskID: task.task.id,
        title: "Draft",
        body: "# Draft\n",
      })
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRevisionTable)
            .set({ id: "revision_renamed_draft" })
            .where(eq(TaskRevisionTable.id, draft.id))
            .run(),
        ),
      ).toThrow()
    }))

  test("serializes duplicate create calls on the process singleton", () =>
    setup(async () => {
      const session = await Session.create({})
      const result = await Promise.allSettled(
        ["First", "Second"].map((title) =>
          SessionTask.create({
            sessionID: session.id,
            title,
            body: `# ${title}\n`,
            source: { type: "user", messageID: MessageID.ascending() },
          }),
        ),
      )

      expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1)
      const failed = result.find((item) => item.status === "rejected")
      expect(failed?.status).toBe("rejected")
      if (failed?.status === "rejected") expect(failed.reason).toBeInstanceOf(SessionTask.Conflict)
    }))

  test("serializes create and draft writes across real processes", () =>
    setup(async () => {
      const session = await Session.create({})
      Database.close()
      const create = path.join(Instance.directory, "create-start")
      const creates = ["First", "Second"].map((title, index) =>
        child(
          "create",
          {
            sessionID: session.id,
            title,
            body: `# ${title}\n`,
            source: { type: "user" },
          },
          { ready: path.join(Instance.directory, `create-ready-${index}`), start: create },
        ),
      )
      await Promise.all([0, 1].map((index) => ready(path.join(Instance.directory, `create-ready-${index}`))))
      await Bun.write(create, "go")
      const created = await Promise.all(creates)

      expect(created.map((item) => item.status).sort()).toEqual(["conflict", "success"])
      const task = await SessionTask.get(session.id)
      expect(task?.revision.version).toBe(1)
      Database.close()

      const start = path.join(Instance.directory, "draft-start")
      const drafts = ["Second revision", "Third revision"].map((title, index) =>
        child(
          "draft",
          {
            taskID: task?.task.id,
            title,
            body: `# ${title}\n`,
          },
          { ready: path.join(Instance.directory, `draft-ready-${index}`), start },
        ),
      )
      await Promise.all([0, 1].map((index) => ready(path.join(Instance.directory, `draft-ready-${index}`))))
      await Bun.write(start, "go")
      const drafted = await Promise.all(drafts)

      expect(drafted.filter((item) => item.status === "conflict")).toEqual([])
      expect(drafted.map((item) => item.status)).toEqual(["success", "success"])
      expect(drafted.map((item) => item.version).sort()).toEqual([2, 3])
    }))

  test("normalizes a bounded write-lock timeout to a task conflict", () =>
    setup(async () => {
      const session = await Session.create({})
      Database.Client().run(sql`PRAGMA busy_timeout = 50`)
      const proc = await lock()

      await expect(
        SessionTask.create({
          sessionID: session.id,
          title: "Contended task",
          body: "# Contended task\n",
          source: { type: "user" },
        }),
      ).rejects.toBeInstanceOf(SessionTask.Conflict)
      expect(await proc.exited).toBe(0)
    }))

  test("normalizes outer transaction lock failures for binding sync and finish", () =>
    setup(async () => {
      Database.Client().run(sql`PRAGMA busy_timeout = 50`)
      const confirm = await Session.create({})
      const action = {
        type: "action",
        id: "confirm_lock",
        title: "Confirm lock",
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { assignment: { op: "create", target: "self" } },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      await SessionAssignment.confirm({
        action,
        messageID: MessageID.ascending(),
        plan: "Confirm lock",
        runID: "run_confirm_lock",
        sessionID: confirm.id,
      })
      const first = await lock()
      await expect(
        SessionTask.confirmed({
          sessionID: confirm.id,
          runID: "run_confirm_lock",
          actionIDs: [action.id],
          actions: [],
          legacy: { title: "Legacy", body: "Legacy" },
          requiresAssignment: true,
        }),
      ).rejects.toBeInstanceOf(SessionTask.Conflict)
      await first.exited

      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const delegated = {
        ...action,
        id: "delegate_lock",
        operation: "agent",
        executor: { type: "agent", target: "worker", capabilities: [] },
      } as AgentProtocol.Action
      await SessionAssignment.delegate({
        action: delegated,
        childID: child.id,
        messageID: MessageID.ascending(),
        runID: "run_delegate_lock",
        sessionID: parent.id,
      })
      const second = await lock()
      await expect(
        SessionTask.beginDelegated({
          sessionID: child.id,
          parentSessionID: parent.id,
          parentRunID: "run_delegate_lock",
          parentActionID: delegated.id,
        }),
      ).rejects.toBeInstanceOf(SessionTask.Conflict)
      await second.exited

      const session = await Session.create({})
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_sync_lock",
        assignment: { op: "create", target: "self", title: "Sync lock", body: "Sync lock" },
        actions: [{ id: "sync_lock", title: "Sync lock" }],
      })
      const third = await lock()
      await expect(
        SessionTask.sync({
          sessionID: session.id,
          runID: "run_sync_lock",
          actions: result("run_sync_lock", [{ id: "sync_lock", title: "Sync lock", status: "completed" }]).actions,
        }),
      ).rejects.toBeInstanceOf(SessionTask.Conflict)
      await third.exited

      const fourth = await lock()
      await expect(
        SessionTask.finish({
          sessionID: session.id,
          runID: "run_sync_lock",
          summary: "Done",
          source: "protocol",
        }),
      ).rejects.toBeInstanceOf(SessionTask.Conflict)
      await fourth.exited
      Database.Client().run(sql`PRAGMA busy_timeout = 5000`)
    }))

  test("does not normalize ordinary errors that resemble SQLite failures", () =>
    setup(async () => {
      const session = await Session.create({})
      const transaction = Database.transaction
      try {
        for (const message of ["UNIQUE constraint failed", "database is locked"]) {
          const err = new Error(message)
          Object.defineProperty(Database, "transaction", {
            configurable: true,
            value: () => {
              throw err
            },
          })
          await expect(
            SessionTask.create({
              sessionID: session.id,
              title: "Preserve ordinary error",
              body: "# Preserve ordinary error\n",
              source: { type: "user" },
            }),
          ).rejects.toBe(err)
        }
      } finally {
        Object.defineProperty(Database, "transaction", { configurable: true, value: transaction })
      }
    }))

  test("reads only the current revision and loads archived bodies on demand", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Original task",
        body: "# Original task\n",
        source: { type: "user" },
      })
      const run = protocol("run_current_task", "Current task")
      await Storage.write(["session_protocol_run", session.id, run.run_id], run)
      await SessionRuns.finish({
        sessionID: session.id,
        runID: run.run_id,
        summary: "Final model synthesis",
        messageID: "msg_current_task",
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Current task",
        body: "# Current task\n",
      })
      Database.use((db) =>
        db
          .update(TaskRevisionTable)
          .set({ workflow: { actions: [], run_id: run.run_id } })
          .where(eq(TaskRevisionTable.id, draft.id))
          .run(),
      )
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
      await SessionTask.finish({
        sessionID: session.id,
        runID: run.run_id,
        summary: "Final model synthesis",
        source: "protocol",
      })

      const current = await SessionTask.current(session.id)
      expect(current?.body).toContain("Current task")
      expect(current?.result).toBe("Final model synthesis")
      expect(current?.result_source).toBe("protocol")
      expect(current?.progress).toEqual({ completed: 0, total: 0 })
      expect(current?.handoffs).toEqual([])
      expect((await SessionTask.history(session.id))[0]).toMatchObject({ version: 1, status: "archived" })
      expect((await SessionTask.history(session.id))[0]).not.toHaveProperty("body")
      expect((await SessionTask.history(session.id))[0]).not.toHaveProperty("workflow")
      expect((await SessionTask.history(session.id))[0]?.result).toEqual({ present: false })
      expect((await SessionTask.revision(session.id, 1))?.body).toContain("Original task")

      Database.use((db) =>
        db
          .update(TaskRevisionTable)
          .set({ terminal_status: null, stopped_child_count: null, result_status: null })
          .where(eq(TaskRevisionTable.id, first.revision.id))
          .run(),
      )
      const archived = (await SessionTask.history(session.id))[0]
      expect(archived).not.toHaveProperty("terminal_status")
      expect(archived).not.toHaveProperty("stopped_child_count")
      expect(archived?.result).toEqual({ present: false })
    }))

  test("classifies trusted results from archived rows created before result metadata", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Legacy archive",
        body: "# Legacy archive\n",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({ taskID: first.task.id, title: "Current", body: "# Current\n" })
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
      const action = result("run_legacy_archive", [
        { id: "legacy_result", title: "Legacy result", status: "completed" },
      ]).actions[0]!

      const cases = [
        {
          result: "Protocol result",
          source: "protocol",
          canonical: undefined,
          expected: { present: true, status: "completed" },
        },
        {
          result: "Fallback result",
          source: "fallback_summary",
          canonical: undefined,
          expected: { present: true, status: "partial" },
        },
        {
          result: "Action completed",
          source: "action_result",
          canonical: "completed",
          carrier: "action_result",
          expected: { present: true, status: "completed" },
        },
        {
          result: "Action failed",
          source: "action_result",
          canonical: "failed",
          carrier: "action_result",
          expected: { present: true, status: "failed" },
        },
        {
          result: "Action aborted",
          source: "action_result",
          canonical: "aborted",
          carrier: "action_result",
          expected: { present: true, status: "failed" },
        },
        {
          result: "Action ambiguous",
          source: "action_result",
          canonical: "ambiguous",
          carrier: "action_result",
          expected: { present: true },
        },
        {
          result: "Fallback carrier",
          source: "action_result",
          canonical: "completed",
          carrier: "fallback_summary",
          expected: { present: true },
        },
        {
          result: "Synthetic carrier",
          source: "action_result",
          canonical: "completed",
          carrier: "synthetic",
          expected: { present: true },
        },
        {
          result: "Protocol carrier",
          source: "action_result",
          canonical: "completed",
          carrier: "agent_protocol_output",
          expected: { present: true },
        },
        { result: "Action unknown", source: "action_result", canonical: undefined, expected: { present: true } },
        { result: "Untrusted result", source: null, canonical: undefined, expected: { present: false } },
        { result: null, source: null, canonical: undefined, expected: { present: false } },
      ] as const
      for (const item of cases) {
        Database.use((db) => {
          db.delete(SessionResultTable).where(eq(SessionResultTable.parent_session_id, session.id)).run()
          if (item.canonical) {
            const statuses = item.canonical === "ambiguous" ? ["completed", "failed"] : [item.canonical]
            db.insert(SessionResultTable)
              .values(
                statuses.map((status, index) => ({
                  id: `result_${item.canonical}_${index}`,
                  carrier: ("carrier" in item ? item.carrier : "action_result") as never,
                  status: status as never,
                  satisfying: status === "completed",
                  session_id: session.id,
                  parent_session_id: session.id,
                  child_session_id: null,
                  run_id: "run_legacy_archive",
                  action_id: "legacy_result",
                  target_action_id: null,
                  raw_ref: `legacy/${item.canonical}/${index}`,
                  summary: item.result,
                  created_at: Date.now(),
                })),
              )
              .run()
          }
          db.update(TaskRevisionTable)
            .set({
              result: item.result,
              result_source: item.source,
              result_status: null,
              workflow: { actions: [{ ...action, run_id: "run_legacy_archive" }] },
            })
            .where(eq(TaskRevisionTable.id, first.revision.id))
            .run()
        })
        expect((await SessionTask.history(session.id))[0]?.result).toEqual(item.expected)
        const revision = await SessionTask.revision(session.id, 1)
        expect(revision?.result_status).toBe("status" in item.expected ? item.expected.status : undefined)
        expect(revision?.result).toBe(item.expected.present && item.result ? item.result : undefined)
      }
    }))

  test("does not backfill legacy action results as completed without canonical evidence", async () => {
    const migration = await Bun.file(
      new URL("../../migration/20260718190000_task_revision_archive_metadata/migration.sql", import.meta.url),
    ).text()
    expect(migration).not.toContain("action_result")
    const correction = await Bun.file(
      new URL("../../migration/20260718213000_task_revision_stop_ledger/migration.sql", import.meta.url),
    ).text()
    expect(correction).toContain("`result_source` = 'action_result'")
    expect(correction).toContain("SET `result_status` = NULL")
  })

  test("indexes canonical action results once for multiple archived revisions", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "First",
        body: "# First\n",
        source: { type: "user" },
      })
      const seed = (revision: string, run: string, action: string, status: "completed" | "failed") =>
        Database.use((db) => {
          const item = result(run, [{ id: action, title: action, status }]).actions[0]!
          db.update(TaskRevisionTable)
            .set({
              workflow: { actions: [{ ...item, run_id: run }] },
              result: `${action} result`,
              result_source: "action_result",
            })
            .where(eq(TaskRevisionTable.id, revision))
            .run()
          db.insert(SessionResultTable)
            .values({
              id: `result_${action}`,
              carrier: "action_result",
              status,
              satisfying: status === "completed",
              session_id: session.id,
              parent_session_id: session.id,
              child_session_id: null,
              run_id: run,
              action_id: action,
              target_action_id: null,
              raw_ref: `history/${action}`,
              summary: `${action} result`,
              created_at: Date.now(),
            })
            .run()
        })
      seed(first.revision.id, "run_history_first", "history_first", "completed")
      const second = await SessionTask.draft({ taskID: first.task.id, title: "Second", body: "# Second\n" })
      await SessionTask.activate({ taskID: first.task.id, revisionID: second.id })
      seed(second.id, "run_history_second", "history_second", "failed")
      const third = await SessionTask.draft({ taskID: first.task.id, title: "Third", body: "# Third\n" })
      await SessionTask.activate({ taskID: first.task.id, revisionID: third.id })
      Database.use((db) =>
        db
          .update(TaskRevisionTable)
          .set({ result_status: null })
          .where(inArray(TaskRevisionTable.id, [first.revision.id, second.id]))
          .run(),
      )

      const use = Database.use
      let calls = 0
      const spy = spyOn(Database, "use").mockImplementation(((fn) => {
        calls++
        return use(fn)
      }) as typeof Database.use)
      try {
        expect((await SessionTask.history(session.id)).map((item) => item.result.status)).toEqual([
          "failed",
          "completed",
        ])
        expect(calls).toBe(3)
      } finally {
        spy.mockRestore()
      }
    }))

  test("derives archived terminal status from compact-only progress", () =>
    setup(async () => {
      for (const item of [
        { compact: { runs: 3, completed: 4, total: 4 }, actions: [], expected: "completed" },
        { compact: { runs: 3, completed: 3, total: 4 }, actions: [], expected: "blocked" },
        {
          compact: { runs: 3, completed: 4, total: 4 },
          actions: result("run_compact_failed", [{ id: "failed", title: "Failed", status: "failed" }]).actions,
          expected: "failed",
        },
        {
          compact: { runs: 3, completed: 4, total: 4 },
          actions: result("run_compact_blocked", [{ id: "blocked", title: "Blocked", status: "blocked" }]).actions,
          expected: "blocked",
        },
      ] as const) {
        const session = await Session.create({})
        const first = await SessionTask.create({
          sessionID: session.id,
          title: "Compact archive",
          body: "# Compact archive\n",
          source: { type: "user" },
        })
        Database.use((db) =>
          db
            .update(TaskRevisionTable)
            .set({
              workflow: {
                actions: item.actions.map((action) => ({ ...action, run_id: "run_compact_priority" })),
                compact: item.compact,
              },
            })
            .where(eq(TaskRevisionTable.id, first.revision.id))
            .run(),
        )
        const draft = await SessionTask.draft({ taskID: first.task.id, title: "Current", body: "# Current\n" })
        await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
        expect((await SessionTask.history(session.id))[0]?.terminal_status).toBe(item.expected)
      }
    }))

  test("ignores non-action carriers when archiving canonical result metadata", () =>
    setup(async () => {
      for (const carrier of ["fallback_summary", "synthetic", "agent_protocol_output"] as const) {
        const session = await Session.create({})
        const first = await SessionTask.create({
          sessionID: session.id,
          title: "Carrier archive",
          body: "# Carrier archive\n",
          source: { type: "user" },
        })
        const action = result("run_carrier_archive", [
          { id: "carrier_action", title: "Carrier action", status: "completed" },
        ]).actions[0]!
        Database.use((db) => {
          db.update(TaskRevisionTable)
            .set({ workflow: { actions: [{ ...action, run_id: "run_carrier_archive" }] } })
            .where(eq(TaskRevisionTable.id, first.revision.id))
            .run()
          db.insert(SessionResultTable)
            .values({
              id: `result_carrier_${carrier}`,
              carrier,
              status: "failed",
              satisfying: false,
              session_id: session.id,
              parent_session_id: session.id,
              child_session_id: null,
              run_id: "run_carrier_archive",
              action_id: "carrier_action",
              target_action_id: null,
              raw_ref: `carrier/${carrier}`,
              summary: "Mismatched carrier",
              created_at: Date.now(),
            })
            .run()
        })
        const draft = await SessionTask.draft({ taskID: first.task.id, title: "Current", body: "# Current\n" })
        await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
        expect(await SessionTask.revision(session.id, 1)).toMatchObject({
          terminal_status: "completed",
        })
        expect((await SessionTask.revision(session.id, 1))?.result_status).toBeUndefined()
      }
    }))

  test("archives only canonical child results across current result carriers", () =>
    setup(async () => {
      const archive = async (input: {
        id: string
        actions: { id: string; status: "completed" | "failed" | "blocked" }[]
        rows: {
          action: string
          carrier: "action_result" | "fallback_summary" | "agent_protocol_output" | "plain_text_result" | "synthetic"
          status: "completed" | "partial" | "failed" | "blocked" | "waiting_user"
        }[]
        shared?: boolean
        wrong?: "completed" | "failed"
      }) => {
        const session = await Session.create({})
        const first = await SessionTask.create({
          sessionID: session.id,
          title: input.id,
          body: `# ${input.id}\n`,
          source: { type: "user" },
        })
        const run = `run_${input.id}`
        const actions = input.actions.map((item) => ({
          type: "action",
          id: item.id,
          title: item.id,
          operation: "delegate",
          executor: { type: "agent", target: "backend", capabilities: [] },
          input: {},
          depends_on: [],
          context_refs: [],
          result_policy: "summary",
        })) as AgentProtocol.Action[]
        const child = input.shared ? await Session.create({ parentID: session.id }) : undefined
        const children = child
          ? actions.map(() => child)
          : await Promise.all(actions.map(() => Session.create({ parentID: session.id })))
        const wrong = input.wrong ? await Session.create({ parentID: session.id }) : undefined
        await Promise.all(
          actions.map((action, index) =>
            SessionAssignment.delegate({
              action,
              childID: children[index]!.id,
              messageID: MessageID.ascending(),
              runID: run,
              sessionID: session.id,
            }),
          ),
        )
        Database.use((db) => {
          db.update(TaskRevisionTable)
            .set({
              workflow: {
                actions: result(
                  run,
                  input.actions.map((item) => ({ ...item, title: item.id })),
                ).actions.map((action) => ({
                  ...action,
                  executor: { type: "agent", target: "backend", capabilities: [] },
                  run_id: run,
                })),
              },
            })
            .where(eq(TaskRevisionTable.id, first.revision.id))
            .run()
          input.rows.forEach((row, index) => {
            const child = children[input.actions.findIndex((item) => item.id === row.action)]!
            db.insert(SessionResultTable)
              .values({
                id: `result_${input.id}_${index}`,
                carrier: row.carrier,
                status: row.status,
                satisfying: row.status === "completed",
                session_id: child.id,
                parent_session_id: session.id,
                child_session_id: child.id,
                run_id: run,
                action_id: row.action,
                target_action_id: null,
                raw_ref: `archive/${input.id}/${index}`,
                summary: `${row.action} result`,
                created_at: Date.now(),
              })
              .run()
          })
          if (!input.wrong || !wrong) return
          db.insert(SessionResultTable)
            .values({
              id: `result_${input.id}_wrong`,
              carrier: "action_result",
              status: input.wrong,
              satisfying: input.wrong === "completed",
              session_id: wrong.id,
              parent_session_id: session.id,
              child_session_id: wrong.id,
              run_id: run,
              action_id: input.actions[0]!.id,
              target_action_id: null,
              raw_ref: `archive/${input.id}/wrong`,
              summary: "Wrong child result",
              created_at: Date.now(),
            })
            .run()
        })
        const draft = await SessionTask.draft({ taskID: first.task.id, title: "Current", body: "# Current\n" })
        await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
        return SessionTask.revision(session.id, 1)
      }

      expect(
        await archive({
          id: "mixed",
          actions: [
            { id: "native", status: "completed" },
            { id: "fallback", status: "completed" },
          ],
          rows: [
            { action: "native", carrier: "action_result", status: "completed" },
            { action: "fallback", carrier: "fallback_summary", status: "partial" },
          ],
        }),
      ).toMatchObject({ terminal_status: "completed", result_status: "partial" })
      expect(
        await archive({
          id: "fallback",
          actions: [
            { id: "first", status: "completed" },
            { id: "second", status: "completed" },
          ],
          rows: [
            { action: "first", carrier: "fallback_summary", status: "partial" },
            { action: "second", carrier: "fallback_summary", status: "partial" },
          ],
        }),
      ).toMatchObject({ terminal_status: "completed", result_status: "partial" })
      expect(
        await archive({
          id: "failed",
          actions: [{ id: "failed", status: "failed" }],
          rows: [{ action: "failed", carrier: "plain_text_result", status: "failed" }],
        }),
      ).toMatchObject({ terminal_status: "failed", result_status: "failed" })
      expect(
        await archive({
          id: "blocked",
          actions: [{ id: "blocked", status: "blocked" }],
          rows: [{ action: "blocked", carrier: "agent_protocol_output", status: "waiting_user" }],
        }),
      ).toMatchObject({ terminal_status: "blocked", result_status: "partial" })
      expect(
        await archive({
          id: "synthetic",
          actions: [{ id: "synthetic", status: "completed" }],
          rows: [{ action: "synthetic", carrier: "synthetic", status: "partial" }],
          wrong: "failed",
        }),
      ).toMatchObject({ terminal_status: "completed", result_status: "partial" })
      expect(
        await archive({ id: "missing", actions: [{ id: "missing", status: "completed" }], rows: [] }),
      ).toMatchObject({ terminal_status: "blocked" })
      expect(
        (await archive({ id: "missing_status", actions: [{ id: "missing", status: "completed" }], rows: [] }))
          ?.result_status,
      ).toBeUndefined()
      expect(
        await archive({
          id: "shared_child_missing",
          actions: [
            { id: "present", status: "completed" },
            { id: "missing", status: "completed" },
          ],
          rows: [{ action: "present", carrier: "fallback_summary", status: "partial" }],
          shared: true,
        }),
      ).toMatchObject({ terminal_status: "blocked", result_status: "partial" })
    }))

  for (const item of [
    {
      title: "blocks a completed delegated action without an assignment locator",
      id: "missing_locator",
      root: "assignment_scope_current",
      locators: [],
    },
    {
      title: "ignores the same workflow key owned by another revision parent",
      id: "foreign_parent",
      root: "assignment_scope_current",
      locators: [
        {
          run: "run_foreign_parent",
          action: "action_foreign_parent",
          parent: "assignment_scope_other",
        },
      ],
    },
    {
      title: "ignores an assignment under the current parent when its key is outside the workflow",
      id: "foreign_key",
      root: "assignment_scope_current",
      locators: [
        {
          run: "run_foreign_key_other",
          action: "action_foreign_key_other",
          parent: "assignment_scope_current",
        },
      ],
    },
  ] as const) {
    test(item.title, () =>
      setup(async () => {
        expect(await scoped(item)).toMatchObject({ terminal_status: "blocked" })
      }),
    )
  }

  test("rejects duplicate assignment locators instead of trusting map overwrite", () => {
    const found = locators([
      { run: "run_duplicate_locator", action: "action_duplicate_locator", child: SessionID.make("ses_first") },
      { run: "run_duplicate_locator", action: "action_duplicate_locator", child: SessionID.make("ses_second") },
    ])
    expect(found.ambiguous).toBe(true)
    expect(found.values.size).toBe(0)
  })

  test("does not reuse a result from an archived revision", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Original task",
        body: "# Original task\n",
        source: { type: "user" },
      })
      Database.use((db) =>
        db
          .update(TaskRevisionTable)
          .set({ result: "Old result", result_source: "protocol" })
          .where(eq(TaskRevisionTable.id, first.revision.id))
          .run(),
      )
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Current task",
        body: "# Current task\n",
      })
      Database.use((db) =>
        db
          .update(TaskRevisionTable)
          .set({ workflow: { actions: [{ id: "incomplete" }] } })
          .where(eq(TaskRevisionTable.id, draft.id))
          .run(),
      )
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })

      expect((await SessionTask.current(session.id))?.result).toBeUndefined()
      expect((await SessionTask.current(session.id))?.actions).toEqual([])
      expect((await SessionTask.revision(session.id, 1))?.result).toBe("Old result")
      expect((await SessionTask.revision(session.id, 2))?.workflow.actions).toEqual([])
    }))

  posix("publishes markdown projections and reports drift without changing the database", () =>
    setup(async () => {
      const session = await Session.create({})
      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Documented task",
        body: "# Documented task\n\nTrusted body.\n",
        source: { type: "user" },
      })
      const read = await TaskDocuments.read(session.id, saved.task.id, 1)
      expect(read?.body).toContain("Trusted body")
      expect(read?.drifted).toBe(false)
      const file = path.join(
        Instance.directory,
        ".harness",
        "sessions",
        session.id,
        "tasks",
        saved.task.id,
        "revisions",
        "v1",
        "task.md",
      )
      const root = path.join(Instance.directory, ".harness", "sessions", session.id, "tasks", saved.task.id)
      const manifest = path.join(root, "manifest.md")
      const before = await Bun.file(manifest).text()
      const blocked = path.join(Instance.directory, "blocked")
      await Bun.write(path.join(blocked, "keep"), "safe")
      await symlink(blocked, path.join(root, "revisions", "v2"))
      expect(
        TaskDocuments.publish({
          sessionID: session.id,
          taskID: saved.task.id,
          version: 2,
          title: "Unsafe projection",
          body: "# Unsafe projection\n",
          current: true,
        }),
      ).toBe(false)
      expect(await Bun.file(manifest).text()).toBe(before)
      await Bun.write(file, "# Drifted\n")
      expect(await TaskDocuments.read(session.id, saved.task.id, 1)).toMatchObject({
        body: "# Drifted\n",
        drifted: true,
      })
      expect((await SessionTask.revision(session.id, 1))?.body).toContain("Trusted body")
      expect(await Array.fromAsync(new Bun.Glob("*.tmp").scan({ cwd: path.dirname(file), absolute: true }))).toEqual([])
      const outside = path.join(Instance.directory, "outside.md")
      await Bun.write(outside, "# Secret\n")
      await unlink(file)
      await symlink(outside, file)
      expect(await TaskDocuments.read(session.id, saved.task.id, 1)).toBeUndefined()
      expect(await TaskDocuments.read(session.id, saved.task.id, "../1")).toBeUndefined()
    }),
  )

  test("keeps the database commit when a projection path is unsafe", () =>
    setup(async () => {
      const outside = path.join(Instance.directory, "outside")
      await Bun.write(path.join(outside, "keep"), "safe")
      await symlink(outside, path.join(Instance.directory, ".harness"))
      const session = await Session.create({})

      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Authoritative task",
        body: "# Authoritative task\n",
        source: { type: "user" },
      })

      expect((await SessionTask.get(session.id))?.task.id).toBe(saved.task.id)
      expect(await Bun.file(path.join(outside, "keep")).text()).toBe("safe")
      expect(await Bun.file(path.join(outside, "sessions", session.id)).exists()).toBe(false)
    }))

  test("keeps the database commit when the projection backend is unavailable", () =>
    setup(async () => {
      using hook = TaskFS.testing({ backend: null })
      const session = await Session.create({})
      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Database-only task",
        body: "# Database-only task\n",
        source: { type: "user" },
      })

      expect((await SessionTask.get(session.id))?.task.id).toBe(saved.task.id)
      expect(await Bun.file(path.join(Instance.directory, ".harness")).exists()).toBe(false)
    }))

  posix("keeps the database commit when projection directory fsync fails", () =>
    setup(async () => {
      using hook = TaskFS.testing({
        sync(_, kind) {
          if (kind === "directory") throw new Error("fsync failed")
        },
      })
      const session = await Session.create({})
      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Durable database task",
        body: "# Durable database task\n",
        source: { type: "user" },
      })

      expect((await SessionTask.get(session.id))?.task.id).toBe(saved.task.id)
      expect(await Array.fromAsync(new Bun.Glob("**/*.tmp").scan({ cwd: Instance.directory, absolute: true }))).toEqual(
        [],
      )
    }),
  )

  posix("keeps the final rename relative to the opened directory after a parent swap", () =>
    setup(async () => {
      const session = await Session.create({})
      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Final rename task",
        body: "# Final rename task\n",
        source: { type: "user" },
      })
      const root = path.join(Instance.directory, ".harness", "sessions", session.id, "tasks", saved.task.id)
      const target = path.join(root, "revisions", "v2")
      const outside = path.join(Instance.directory, "outside-final")
      mkdirSync(outside)
      let tmp = ""
      using hook = TaskFS.testing({
        publish() {
          tmp = readdirSync(target).find((file) => file.endsWith(".tmp")) ?? ""
          renameSync(target, `${target}-safe`)
          writeFileSync(path.join(outside, tmp), "attacker temporary file")
          symlinkSync(outside, target)
        },
      })

      expect(
        Markdown.publish(
          [".harness", "sessions", session.id, "tasks", saved.task.id],
          ["revisions", "v2", "task.md"],
          "# Trusted body\n",
        ),
      ).toBe(true)
      expect(tmp).not.toBe("")
      expect(await Bun.file(path.join(outside, "task.md")).exists()).toBe(false)
      expect(await Bun.file(path.join(outside, tmp)).text()).toBe("attacker temporary file")
      expect(await Bun.file(path.join(`${target}-safe`, "task.md")).text()).toBe("# Trusted body\n")
    }),
  )

  posix("keeps manifest lock and publish operations relative to the opened tasks directory", () =>
    setup(async () => {
      const session = await Session.create({})
      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Relative lock task",
        body: "# Relative lock task\n",
        source: { type: "user" },
      })
      const base = path.join(Instance.directory, ".harness", "sessions", session.id)
      const tasks = path.join(base, "tasks")
      const outside = path.join(Instance.directory, "outside-lock")
      const lock = path.join(outside, `${saved.task.id}.manifest.lock`)
      mkdirSync(path.join(outside, saved.task.id), { recursive: true })
      mkdirSync(lock)
      writeFileSync(path.join(lock, "sentinel"), "keep")
      writeFileSync(path.join(outside, saved.task.id, "manifest.md"), "attacker manifest")
      const stale = new Date(Date.now() - 31_000)
      utimesSync(lock, stale, stale)
      using hook = TaskFS.testing({
        lock() {
          renameSync(tasks, `${tasks}-safe`)
          symlinkSync(outside, tasks)
        },
      })

      expect(
        TaskDocuments.publish({
          sessionID: session.id,
          taskID: saved.task.id,
          version: 1,
          title: saved.revision.title,
          body: saved.revision.body,
          current: true,
        }),
      ).toBe(true)
      expect(await Bun.file(path.join(lock, "sentinel")).text()).toBe("keep")
      expect(await Bun.file(path.join(outside, saved.task.id, "manifest.md")).text()).toBe("attacker manifest")
      expect(await Bun.file(path.join(`${tasks}-safe`, saved.task.id, "manifest.md")).text()).toContain(
        "Current revision: v1",
      )
      expect(statSync(path.join(`${tasks}-safe`, saved.task.id, ".manifest.lock")).isFile()).toBe(true)
      expect(await Bun.file(path.join(outside, saved.task.id, ".manifest.lock")).exists()).toBe(false)
    }),
  )

  posix("rebuilds the manifest from the current database revision across processes", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = await SessionTask.create({
        sessionID: session.id,
        title: "Original task",
        body: "# Original task\n",
        source: { type: "user" },
      })
      const draft = await SessionTask.draft({
        taskID: first.task.id,
        title: "Current task",
        body: "# Current task\n",
      })
      await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
      const gate = {
        ready: path.join(Instance.directory, "old-ready"),
        start: path.join(Instance.directory, "old-start"),
      }
      const old = project(
        {
          sessionID: session.id,
          taskID: first.task.id,
          version: 1,
          title: first.revision.title,
          body: first.revision.body,
          current: true,
        },
        gate,
      )
      await ready(gate.ready)
      await project({
        sessionID: session.id,
        taskID: first.task.id,
        version: 2,
        title: draft.title,
        body: draft.body,
        current: true,
      })
      await Bun.write(gate.start, "go")
      await old

      const manifest = await Bun.file(
        path.join(Instance.directory, ".harness", "sessions", session.id, "tasks", first.task.id, "manifest.md"),
      ).text()
      expect(manifest).toContain("Current revision: v2")
      expect(manifest).not.toContain("Current revision: v1")
      expect(
        statSync(
          path.join(Instance.directory, ".harness", "sessions", session.id, "tasks", first.task.id, ".manifest.lock"),
        ).isFile(),
      ).toBe(true)
    }),
  )

  posix("preserves a legacy manifest lock directory without recovery", () =>
    setup(async () => {
      const session = await Session.create({})
      const saved = await SessionTask.create({
        sessionID: session.id,
        title: "Locked manifest",
        body: "# Locked manifest\n",
        source: { type: "user" },
      })
      const lock = path.join(
        Instance.directory,
        ".harness",
        "sessions",
        session.id,
        "tasks",
        `${saved.task.id}.manifest.lock`,
      )
      mkdirSync(lock)
      expect(
        TaskDocuments.publish({
          sessionID: session.id,
          taskID: saved.task.id,
          version: 1,
          title: saved.revision.title,
          body: saved.revision.body,
          current: true,
        }),
      ).toBe(false)
      expect(statSync(lock).isDirectory()).toBe(true)

      const stale = new Date(Date.now() - 31_000)
      utimesSync(lock, stale, stale)
      expect(
        TaskDocuments.publish({
          sessionID: session.id,
          taskID: saved.task.id,
          version: 1,
          title: saved.revision.title,
          body: saved.revision.body,
          current: true,
        }),
      ).toBe(false)
      expect(statSync(lock).isDirectory()).toBe(true)
    }),
  )

  test("projects zero, one, and multiple legacy runs without merging", () =>
    setup(async () => {
      const session = await Session.create({})
      expect(await SessionTask.legacy(session.id)).toBeUndefined()
      const run = protocol("run_legacy_one", "Legacy task")
      await Storage.write(["session_protocol_run", session.id, run.run_id], run)
      await SessionRuns.finish({
        sessionID: session.id,
        runID: run.run_id,
        summary: "Legacy result",
        messageID: "msg_legacy",
      })
      Database.use((db) =>
        db
          .insert(TaskHandoffTable)
          .values({
            id: "handoff_legacy_view",
            source_session_id: session.id,
            source_task_id: null,
            target_session_id: null,
            target_task_id: null,
            title: "Legacy handoff",
            body: "Legacy handoff body",
            body_hash: "a".repeat(64),
            context_refs: [],
            status: "failed",
            dedupe_key: "handoff_legacy_view",
            error: "Legacy target failed",
            time_created: 10,
          })
          .run(),
      )
      expect(await SessionTask.legacy(session.id)).toMatchObject({
        type: "legacy_task",
        version: 1,
        title: "Legacy task",
        result: "Legacy result",
        result_source: "protocol",
        handoffs: [
          {
            id: "handoff_legacy_view",
            source_session_id: session.id,
            status: "failed",
            error: "Legacy target failed",
          },
        ],
        time: {
          created: run.time.started,
          updated: run.time.completed,
          completed: run.time.completed,
        },
      })
      await Storage.write(["session_protocol_run", session.id, "run_legacy_two"], {
        ...run,
        run_id: "run_legacy_two",
      })
      expect(await SessionTask.legacy(session.id)).toEqual({ type: "legacy_multi_run", count: 2 })
    }))

  test("opens zero legacy runs without binding a task", () =>
    setup(async () => {
      const session = await Session.create({})

      expect(await SessionTask.open(session.id)).toBeUndefined()
      expect(await SessionTask.get(session.id)).toBeUndefined()
    }))

  test("lazily migrates one legacy run once with trusted results", () =>
    setup(async () => {
      const session = await Session.create({})
      const run = protocol("run_legacy_migrate", "Migrated task")
      await Storage.write(["session_protocol_run", session.id, run.run_id], {
        ...run,
        actions: result(run.run_id, [{ id: "legacy_done", title: "legacy_done", status: "completed" }]).actions,
      })
      await SessionRuns.finish({
        sessionID: session.id,
        runID: run.run_id,
        summary: "Trusted legacy result",
        messageID: "msg_legacy_migrate",
      })

      const opened = await Promise.all([SessionTask.open(session.id), SessionTask.open(session.id)])
      const stored = await SessionTask.get(session.id)

      expect(opened[0]).toMatchObject({
        id: stored?.task.id,
        version: 1,
        title: "Migrated task",
        result: "Trusted legacy result",
        result_source: "protocol",
        actions: [{ id: "legacy_done", run_id: run.run_id }],
      })
      expect(opened[1]).toEqual(opened[0])
      expect(stored?.task.source_type).toBe("legacy")
      expect(stored?.task.source_ref).toEqual({
        runID: run.run_id,
        dedupe_key: `legacy-task:${session.id}:${run.run_id}`,
      })
      expect(stored?.revision.workflow).toMatchObject({
        run_id: run.run_id,
        run_ids: [run.run_id],
        actions: [{ id: "legacy_done", run_id: run.run_id }],
      })
      expect(Database.use((db) => db.select().from(SessionTaskTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(TaskRevisionTable).all())).toHaveLength(1)
      expect(await SessionTask.open(session.id)).toEqual(opened[0])
    }))

  test("preserves a failed legacy run result classification", () =>
    setup(async () => {
      const session = await Session.create({})
      const run = { ...protocol("run_legacy_failed", "Failed legacy task"), status: "failed" as const }
      await Storage.write(["session_protocol_run", session.id, run.run_id], run)
      await SessionRuns.finish({
        sessionID: session.id,
        runID: run.run_id,
        summary: "Failed legacy result",
        messageID: "msg_legacy_failed",
      })

      await SessionTask.open(session.id)

      expect(await SessionTask.get(session.id)).toMatchObject({
        task: { status: "failed" },
        revision: { status: "failed", terminal_status: "failed", result_status: "failed" },
      })
    }))

  test("proposes multiple legacy runs as read-only snapshots without binding", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = protocol("run_legacy_first", "First legacy task")
      const second = protocol("run_legacy_second", "Second legacy task")
      await Storage.write(["session_protocol_run", session.id, first.run_id], first)
      await Storage.write(["session_protocol_run", session.id, second.run_id], second)

      const opened = await SessionTask.open(session.id)

      expect(opened).toMatchObject({
        type: "legacy_multi_run",
        count: 2,
        proposal: {
          status: "pending_confirmation",
          session_id: session.id,
          runs: [
            { run_id: second.run_id, title: second.title, status: second.status },
            { run_id: first.run_id, title: first.title, status: first.status },
          ],
        },
      })
      if (!opened || !("type" in opened)) throw new Error("legacy migration proposal missing")
      expect(opened.proposal.runs.every((item) => !("actions" in item))).toBe(true)
      expect(await SessionTask.get(session.id)).toBeUndefined()
      expect(Database.use((db) => db.select().from(TaskRevisionTable).all())).toHaveLength(0)
    }))

  test("reuses a healthy multi-run manifest without rebuilding on repeated opens", () =>
    setup(async () => {
      const session = await Session.create({})
      await legacyRuns(session.id, "healthy")
      expect(await SessionTask.open(session.id)).toMatchObject({ type: "legacy_multi_run", count: 2 })

      const read = Storage.read
      const keys: string[][] = []
      const reads = spyOn(Storage, "read").mockImplementation(async (key) => {
        keys.push(key)
        return read(key)
      })
      const list = spyOn(Storage, "list")
      const atomic = spyOn(Storage, "atomic")
      const probe = spyOn(Storage, "probe")
      try {
        for (let index = 0; index < 3; index++)
          expect(await SessionTask.open(session.id)).toMatchObject({ type: "legacy_multi_run", count: 2 })
        expect(keys).toHaveLength(12)
        expect(
          keys.every(
            (key) => key[0] === "session_protocol_run_manifest" || key[0] === "session_protocol_run_generation",
          ),
        ).toBe(true)
        expect(list).not.toHaveBeenCalled()
        expect(atomic).not.toHaveBeenCalled()
        expect(probe).toHaveBeenCalledTimes(3)
        expect(probe.mock.calls.every((call) => call[1] === 2)).toBe(true)
      } finally {
        reads.mockRestore()
        list.mockRestore()
        atomic.mockRestore()
        probe.mockRestore()
      }
    }))

  test("admits one legacy run before appending an ordinary executable package", () =>
    setup(async () => {
      const session = await Session.create({})
      const old = result("run_legacy_admit", [{ id: "legacy_action", title: "Legacy action", status: "completed" }])
      await Storage.write(["session_protocol_run", session.id, old.run_id], old)
      await SessionRuns.finish({
        sessionID: session.id,
        runID: old.run_id,
        summary: "Legacy result",
        messageID: "msg_legacy_admit",
      })

      await SessionTask.route({
        sessionID: session.id,
        runID: "run_after_legacy",
        legacy: { title: "Unsafe new task", body: "Unsafe new body" },
        actions: [{ id: "new_action" }],
      })
      const stored = await SessionTask.get(session.id)
      expect(stored?.task).toMatchObject({ source_type: "legacy", title: old.title, status: "running" })
      expect(stored?.revision).toMatchObject({
        version: 1,
        result: null,
        result_source: null,
        workflow: {
          run_id: "run_after_legacy",
          run_ids: [old.run_id, "run_after_legacy"],
          actions: [
            { id: "legacy_action", run_id: old.run_id },
            { id: "new_action", run_id: "run_after_legacy" },
          ],
        },
      })
    }))

  test("keeps open and execute admission idempotent for one legacy run", () =>
    setup(async () => {
      for (const mode of ["before", "concurrent"] as const) {
        const session = await Session.create({})
        const old = protocol(`run_legacy_${mode}`, `Legacy ${mode}`)
        await Storage.write(["session_protocol_run", session.id, old.run_id], old)
        const execute = () =>
          SessionTask.route({
            sessionID: session.id,
            runID: `run_new_${mode}`,
            legacy: { title: "Unsafe", body: "Unsafe" },
            actions: [{ id: `new_${mode}` }],
          })
        if (mode === "before") {
          await SessionTask.open(session.id)
          await execute()
        } else {
          await Promise.all([SessionTask.open(session.id), execute()])
        }
        const stored = await SessionTask.get(session.id)
        expect(stored?.revision.version).toBe(1)
        expect(stored?.revision.workflow.run_ids).toEqual([old.run_id, `run_new_${mode}`])
        expect(Database.use((db) => db.select().from(SessionTaskTable).all())).toHaveLength(mode === "before" ? 1 : 2)
      }
    }))

  test("normalizes a confirmed create onto one migrated legacy revision before and after open", () =>
    setup(async () => {
      for (const mode of ["unopened", "opened"] as const) {
        const session = await Session.create({})
        const old = protocol(`run_legacy_confirmed_${mode}`, `Legacy confirmed ${mode}`)
        await Storage.write(["session_protocol_run", session.id, old.run_id], old)
        if (mode === "opened") await SessionTask.open(session.id)
        const proof = await confirmation(session.id, `confirmed_${mode}`, "create", "self")

        const saved = await SessionTask.confirmed({
          sessionID: session.id,
          runID: proof.source_run_id!,
          actionIDs: [proof.source_action_id!],
          actions: [{ id: `confirmed_action_${mode}` }],
          legacy: { title: "Untrusted", body: "Untrusted" },
          requiresAssignment: true,
        })

        expect(saved.type).toBe("execute")
        expect(await SessionTask.get(session.id)).toMatchObject({
          task: { source_type: "legacy", title: old.title },
          revision: {
            version: 1,
            workflow: {
              assignment_id: proof.id,
              actions: [],
            },
          },
        })
        expect((await SessionAssignment.get(proof.id))?.status).toBe("completed")
        expect(
          await SessionTask.confirmed({
            sessionID: session.id,
            runID: proof.source_run_id!,
            actionIDs: [proof.source_action_id!],
            actions: [{ id: `confirmed_action_${mode}` }],
            legacy: { title: "Untrusted", body: "Untrusted" },
            requiresAssignment: true,
          }),
        ).toMatchObject({ type: "replay", revision: { version: 1 } })

        const update = await confirmation(session.id, `confirmed_update_${mode}`, "update", "self")
        const draft = await SessionTask.confirmed({
          sessionID: session.id,
          runID: update.source_run_id!,
          actionIDs: [update.source_action_id!],
          actions: [{ id: `confirmed_update_action_${mode}` }],
          legacy: { title: "Untrusted", body: "Untrusted" },
          requiresAssignment: true,
        })
        if (draft.type !== "update") throw new Error("legacy update draft missing")
        await SessionTask.activate({ taskID: draft.task.id, revisionID: draft.revision.id })
        expect((await SessionTask.get(session.id))?.revision.version).toBe(2)
        expect(
          await SessionTask.confirmed({
            sessionID: session.id,
            runID: proof.source_run_id!,
            actionIDs: [proof.source_action_id!],
            actions: [{ id: `confirmed_action_${mode}` }],
            legacy: { title: "Untrusted", body: "Untrusted" },
            requiresAssignment: true,
          }),
        ).toMatchObject({ type: "replay", revision: { version: 1 } })
        expect((await SessionTask.get(session.id))?.revision.version).toBe(2)

        const late = await confirmation(session.id, `confirmed_late_${mode}`, "create", "self")
        await expect(
          SessionTask.confirmed({
            sessionID: session.id,
            runID: late.source_run_id!,
            actionIDs: [late.source_action_id!],
            actions: [{ id: `confirmed_late_action_${mode}` }],
            legacy: { title: "Untrusted", body: "Untrusted" },
            requiresAssignment: true,
          }),
        ).rejects.toBeInstanceOf(SessionTask.Conflict)
      }
    }))

  test("serializes legacy admission behind a second run store", () =>
    setup(async () => {
      const session = await Session.create({})
      const first = protocol("run_admission_first", "First")
      const second = protocol("run_admission_second", "Second")
      await Storage.write(["session_protocol_run", session.id, first.run_id], first)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const atomic = Storage.atomic
      const hook = spyOn(Storage, "atomic").mockImplementation(async (key, value) => {
        if (key[0] === "session_protocol_run_generation" && (value as { dirty?: boolean }).dirty) {
          entered.resolve()
          await release.promise
        }
        return atomic(key, value)
      })
      try {
        const store = SessionRuns.store(session.id, second)
        await entered.promise
        const route = SessionTask.route({
          sessionID: session.id,
          runID: "run_admission_new",
          legacy: { title: "Unsafe", body: "Unsafe" },
          actions: [{ id: "unsafe" }],
        })
        release.resolve()
        await store
        await expect(route).rejects.toBeInstanceOf(SessionTask.Conflict)
        expect(await SessionTask.get(session.id)).toBeUndefined()
      } finally {
        release.resolve()
        hook.mockRestore()
      }
    }))

  test("uses a stable title for blank or missing legacy migration snapshots", () =>
    setup(async () => {
      const session = await Session.create({})
      await Storage.write(["session_protocol_run", session.id, "run_blank_a"], {
        ...protocol("run_blank_a", "Temporary"),
        title: "",
      })
      await Storage.write(["session_protocol_run", session.id, "run_blank_b"], {
        ...protocol("run_blank_b", "Temporary"),
        title: undefined,
      })

      expect(await SessionTask.open(session.id)).toMatchObject({
        type: "legacy_multi_run",
        proposal: { runs: [{ title: "Legacy task" }, { title: "Legacy task" }] },
      })
    }))

  test("isolates a truncated single legacy run instead of failing task admission", () =>
    setup(async () => {
      const session = await Session.create({})
      const run = protocol("run_truncated_legacy", "Truncated")
      await SessionRuns.store(session.id, run)
      const file = path.join(Global.Path.data, "storage", "session_protocol_run", session.id, `${run.run_id}.json`)
      await Bun.write(file, "{")

      expect(await SessionTask.open(session.id)).toBeUndefined()
      expect(await SessionTask.get(session.id)).toBeUndefined()
      expect(await Bun.file(file).exists()).toBe(false)
      expect(
        (await Array.fromAsync(new Bun.Glob(`${run.run_id}.json.*.corrupt`).scan({ cwd: path.dirname(file) }))).length,
      ).toBe(1)

      const next = protocol("run_after_isolation", "After isolation")
      await SessionRuns.store(session.id, next)
      expect(await SessionRuns.migrationCount(session.id)).toEqual({ count: 1, runID: next.run_id })
      expect(await SessionRuns.migration(session.id)).toMatchObject({ count: 1, runs: [{ run_id: next.run_id }] })
    }))

  test("does not isolate a valid main run when an outcome or transient read fails", () =>
    setup(async () => {
      const session = await Session.create({})
      const run = protocol("run_derived_failure", "Derived failure")
      await Storage.write(["session_protocol_run", session.id, run.run_id], run)
      await Storage.write(["session_protocol_run_outcome", session.id, run.run_id], { invalid: true })
      const file = path.join(Global.Path.data, "storage", "session_protocol_run", session.id, `${run.run_id}.json`)

      await expect(SessionTask.open(session.id)).rejects.toThrow()
      expect(await Bun.file(file).exists()).toBe(true)
      expect(
        (await Array.fromAsync(new Bun.Glob(`${run.run_id}.json.*.corrupt`).scan({ cwd: path.dirname(file) }))).length,
      ).toBe(0)

      await Storage.remove(["session_protocol_run_outcome", session.id, run.run_id])
      const read = Storage.read
      const hook = spyOn(Storage, "read").mockImplementation(async (key) => {
        if (key[0] === "session_protocol_run" && key.at(-1) === run.run_id)
          throw Object.assign(new Error("transient main read"), { code: "EIO" })
        return read(key)
      })
      try {
        await expect(SessionTask.open(session.id)).rejects.toThrow("transient main read")
      } finally {
        hook.mockRestore()
      }
      expect(await Bun.file(file).exists()).toBe(true)
    }))

  test("reclassifies legacy migration after isolating corrupt main runs", () =>
    setup(async () => {
      const single = await Session.create({})
      const valid = protocol("run_reclassify_valid", "Valid")
      await Storage.write(["session_protocol_run", single.id, valid.run_id], valid)
      await Storage.write(["session_protocol_run", single.id, "run_reclassify_corrupt"], { invalid: true })
      expect(await SessionTask.open(single.id)).toMatchObject({ title: valid.title, version: 1 })
      expect(await SessionTask.get(single.id)).toMatchObject({ task: { source_type: "legacy" } })

      const empty = await Session.create({})
      await Storage.write(["session_protocol_run", empty.id, "run_reclassify_bad_a"], { invalid: true })
      await Storage.write(["session_protocol_run", empty.id, "run_reclassify_bad_b"], { invalid: true })
      expect(await SessionTask.open(empty.id)).toBeUndefined()
      expect(await SessionTask.get(empty.id)).toBeUndefined()
    }))

  test("migrates a delegated child legacy run before rejecting its incompatible assignment", () =>
    setup(async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const old = protocol("run_child_legacy", "Child legacy")
      await Storage.write(["session_protocol_run", child.id, old.run_id], old)
      const action = {
        type: "action",
        id: "delegate_after_legacy",
        title: "Delegate after legacy",
        operation: "agent",
        executor: { type: "agent", target: "worker", capabilities: [] },
        input: { prompt: "New delegated task" },
        depends_on: [],
        context_refs: [],
        result_policy: "summary",
      } as AgentProtocol.Action
      await SessionAssignment.delegate({
        action,
        childID: child.id,
        messageID: MessageID.ascending(),
        plan: "New delegated task",
        runID: "run_parent_delegate",
        sessionID: parent.id,
      })
      await expect(
        SessionTask.beginDelegated({
          sessionID: child.id,
          parentSessionID: parent.id,
          parentRunID: "run_parent_delegate",
          parentActionID: action.id,
        }),
      ).rejects.toThrow("session_task_revision_not_active")
      expect(await SessionTask.get(child.id)).toMatchObject({
        task: { source_type: "legacy" },
        revision: { workflow: { run_ids: [old.run_id] } },
      })
    }))

  test("rejects an ordinary executable package after opening a multi-run proposal", () =>
    setup(async () => {
      const session = await Session.create({})
      await legacyRuns(session.id, "opened")
      expect(await SessionTask.open(session.id)).toMatchObject({ type: "legacy_multi_run" })
      await expect(
        SessionTask.route({
          sessionID: session.id,
          runID: "run_legacy_opened_new",
          legacy: { title: "Unsafe", body: "Unsafe" },
          actions: [{ id: "unsafe" }],
        }),
      ).rejects.toThrow("session_task_conflict")
      expect(await SessionTask.get(session.id)).toBeUndefined()
      expect(Database.use((db) => db.select().from(TaskRevisionTable).all())).toHaveLength(0)
    }))

  test("rejects an ordinary executable package without first opening the multi-run proposal", () =>
    setup(async () => {
      const session = await Session.create({})
      await legacyRuns(session.id, "unopened")
      const migration = spyOn(SessionRuns, "migration")
      const full = spyOn(SessionRuns, "persistedList")
      await expect(
        SessionTask.route({
          sessionID: session.id,
          runID: "run_legacy_unopened_new",
          legacy: { title: "Unsafe", body: "Unsafe" },
          actions: [{ id: "unsafe" }],
        }),
      ).rejects.toThrow("session_task_conflict")
      expect(await SessionTask.get(session.id)).toBeUndefined()
      expect(migration).not.toHaveBeenCalled()
      expect(full).not.toHaveBeenCalled()
    }))

  test("rejects update and handoff confirmations as the first multi-run migration", () =>
    setup(async () => {
      for (const op of ["update", "handoff"] as const) {
        const session = await Session.create({})
        await legacyRuns(session.id, op)
        const proof = await confirmation(session.id, `legacy_${op}`, op, op === "update" ? "self" : "peer")
        await expect(
          SessionTask.confirmed({
            sessionID: session.id,
            runID: proof.source_run_id!,
            actionIDs: [proof.source_action_id!],
            actions: [{ id: `new_${op}` }],
            legacy: { title: "Unsafe", body: "Unsafe" },
            requiresAssignment: true,
          }),
        ).rejects.toBeInstanceOf(SessionTask.Conflict)
        expect(await SessionTask.get(session.id)).toBeUndefined()
      }
    }))

  test("lets only a confirmed create win a multi-run migration race", () =>
    setup(async () => {
      const session = await Session.create({})
      await legacyRuns(session.id, "race")
      const proof = await confirmation(session.id, "legacy_race", "create", "self")
      const results = await Promise.allSettled([
        SessionTask.route({
          sessionID: session.id,
          runID: "run_legacy_race_ordinary",
          legacy: { title: "Unsafe", body: "Unsafe" },
          actions: [{ id: "ordinary" }],
        }),
        SessionTask.confirmed({
          sessionID: session.id,
          runID: proof.source_run_id!,
          actionIDs: [proof.source_action_id!],
          actions: [{ id: "confirmed" }],
          legacy: { title: "Unsafe", body: "Unsafe" },
          requiresAssignment: true,
        }),
      ])
      expect(results[0]?.status).toBe("rejected")
      expect(results[1]?.status).toBe("fulfilled")
      expect(await SessionTask.current(session.id)).toMatchObject({ title: "legacy_race", version: 1 })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({
        actions: [],
        assignment_id: proof.id,
      })
      expect(JSON.stringify((await SessionTask.get(session.id))?.revision.workflow)).not.toContain(
        "run_legacy_race_old",
      )
      expect(Database.use((db) => db.select().from(SessionTaskTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(TaskRevisionTable).all())).toHaveLength(1)
      await SessionTask.route({
        sessionID: session.id,
        runID: "run_legacy_race_followup",
        legacy: { title: "Ignored", body: "Ignored" },
        actions: [{ id: "followup" }],
      })
      expect((await SessionTask.get(session.id))?.revision.workflow).toMatchObject({
        run_id: "run_legacy_race_followup",
        run_ids: ["run_legacy_race_followup"],
      })
    }))
})

async function legacyRuns(sessionID: SessionID, key: string) {
  await Storage.write(
    ["session_protocol_run", sessionID, `run_legacy_${key}_old_a`],
    protocol(`run_legacy_${key}_old_a`, "Legacy A"),
  )
  await Storage.write(
    ["session_protocol_run", sessionID, `run_legacy_${key}_old_b`],
    protocol(`run_legacy_${key}_old_b`, "Legacy B"),
  )
}

async function confirmation(
  sessionID: SessionID,
  id: string,
  op: "create" | "update" | "handoff",
  target: "self" | "peer",
) {
  const action = {
    type: "action",
    id,
    title: id,
    operation: "confirm",
    executor: { type: "human", target: "user", capabilities: ["confirmation"] },
    input: { assignment: { op, target } },
    depends_on: [],
    context_refs: [],
    result_policy: "summary",
  } as AgentProtocol.Action
  const saved = await SessionAssignment.confirm({
    action,
    messageID: MessageID.ascending(),
    plan: `${id} plan`,
    runID: `run_${id}`,
    sessionID,
  })
  if (!saved) throw new Error("confirmation assignment missing")
  return saved
}

function protocol(id: string, title: string) {
  return AgentProtocol.Result.parse({
    type: "agent.protocol.result",
    version: "1",
    run_id: id,
    status: "completed",
    title,
    actions: [],
    summary: "Execution summary",
    time: { started: Date.now(), completed: Date.now() },
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

function result(id: string, actions: { id: string; title: string; status: "completed" | "failed" | "blocked" }[]) {
  const now = Date.now()
  return AgentProtocol.Result.parse({
    type: "agent.protocol.result",
    version: "1",
    run_id: id,
    status: actions.some((item) => item.status === "failed") ? "failed" : "completed",
    title: id,
    actions: actions.map((item) => ({
      id: item.id,
      title: item.title,
      operation: "test",
      executor: { type: "tool", target: "read", capabilities: [] },
      input: {},
      depends_on: [],
      status: item.status,
      summary: `${item.title} summary`,
      output: `${item.title} output`,
      tool_call_ids: [],
      duration_ms: 1,
      time: { started: now, completed: now + 1 },
    })),
    summary: `${id} summary`,
    time: { started: now, completed: now + 1 },
    metrics: {
      actions: actions.length,
      internal_tool_calls: actions.length,
      direct_model_tool_calls: 0,
      model_visible_bytes: 0,
      raw_output_bytes: 0,
      duration_ms: 1,
    },
  })
}
