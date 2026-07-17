import { afterEach, describe, expect, test } from "bun:test"
import { symlink, unlink } from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { AgentProtocol } from "../../src/protocol/schema"
import { Session } from "../../src/session"
import { SessionRuns } from "../../src/session/runs"
import { MessageID } from "../../src/session/schema"
import { SessionTaskTable, TaskHandoffTable, TaskRevisionTable } from "../../src/session/session.sql"
import { SessionTask } from "../../src/session/task"
import { TaskDocuments } from "../../src/session/task-documents"
import { Database, eq, sql } from "../../src/storage/db"
import { Storage } from "../../src/storage/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
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
}

async function child(op: "create" | "draft", input: Record<string, unknown>) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { SessionTask } from "./src/session/task.ts"
        import { Database } from "./src/storage/db.ts"
        const input = JSON.parse(process.env.TASK_INPUT)
        try {
          const result = await SessionTask[process.env.TASK_OP](input)
          console.log("TASK_RESULT:" + JSON.stringify({
            status: "success",
            version: result.revision?.version ?? result.version,
          }))
        } catch (err) {
          if (!(err instanceof SessionTask.Conflict)) throw err
          console.log("TASK_RESULT:" + JSON.stringify({ status: "conflict" }))
        } finally {
          Database.close()
        }
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: { ...process.env, TASK_OP: op, TASK_INPUT: JSON.stringify(input) },
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

describe("session task", () => {
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

  test("rejects dangling and cross-task revision and handoff references", () =>
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
      ).toThrow()
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
      ).toThrow()

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
      const created = await Promise.all(
        ["First", "Second"].map((title) =>
          child("create", {
            sessionID: session.id,
            title,
            body: `# ${title}\n`,
            source: { type: "user" },
          }),
        ),
      )

      expect(created.map((item) => item.status).sort()).toEqual(["conflict", "success"])
      const task = await SessionTask.get(session.id)
      expect(task?.revision.version).toBe(1)
      Database.close()

      const drafted = await Promise.all(
        ["Second revision", "Third revision"].map((title) =>
          child("draft", {
            taskID: task?.task.id,
            title,
            body: `# ${title}\n`,
          }),
        ),
      )

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

      const current = await SessionTask.current(session.id)
      expect(current?.body).toContain("Current task")
      expect(current?.result).toBe("Final model synthesis")
      expect(current?.result_source).toBe("protocol")
      expect(current?.progress).toEqual({ completed: 0, total: 0 })
      expect(current?.handoffs).toEqual([])
      expect((await SessionTask.history(session.id))[0]).toMatchObject({ version: 1, status: "archived" })
      expect((await SessionTask.history(session.id))[0]).not.toHaveProperty("body")
      expect((await SessionTask.history(session.id))[0]).not.toHaveProperty("workflow")
      expect((await SessionTask.history(session.id))[0]).not.toHaveProperty("result")
      expect((await SessionTask.revision(session.id, 1))?.body).toContain("Original task")
    }))

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

  test("publishes markdown projections and reports drift without changing the database", () =>
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
    }))

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
      expect(await SessionTask.legacy(session.id)).toMatchObject({
        type: "legacy_task",
        version: 1,
        title: "Legacy task",
        result: "Legacy result",
        result_source: "protocol",
        handoffs: [],
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
})

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
