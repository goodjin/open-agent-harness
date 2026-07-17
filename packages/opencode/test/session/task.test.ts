import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { SessionTaskTable, TaskHandoffTable, TaskRevisionTable } from "../../src/session/session.sql"
import { SessionTask } from "../../src/session/task"
import { Database, eq, sql } from "../../src/storage/db"
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
})
