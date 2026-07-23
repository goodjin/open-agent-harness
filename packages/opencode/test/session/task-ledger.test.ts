import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import {
  SessionTaskTable,
  TaskCommandTable,
  TaskEventTable,
  TaskRequirementTable,
  TaskRevisionTable,
  TaskResourceTable,
} from "../../src/session/session.sql"
import { SessionTask } from "../../src/session/task"
import { TaskLedger } from "../../src/session/task-ledger"
import { Database, eq } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

async function setup<T>(fn: () => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: () =>
      WorkspaceContext.provide({
        workspaceID: WorkspaceID.make("wrk_task_ledger"),
        fn,
      }),
  })
}

async function task() {
  const session = await Session.create({})
  return SessionTask.create({
    sessionID: session.id,
    title: "Durable task",
    body: "# Durable task\n",
    source: { type: "user" },
  })
}

function journal(end = Infinity) {
  const dir = new URL("../../migration/", import.meta.url)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(new URL(`${entry.name}/migration.sql`, dir), "utf8"),
      timestamp: Number(entry.name.slice(0, 14)),
      name: entry.name,
    }))
    .filter((entry) => entry.timestamp < end)
    .sort((a, b) => a.timestamp - b.timestamp)
}

async function flag(all?: string, ledger?: string) {
  const env = { ...process.env }
  delete env.OPENCODE_EXPERIMENTAL
  delete env.OPENCODE_EXPERIMENTAL_TASK_LEDGER
  if (all) env.OPENCODE_EXPERIMENTAL = all
  if (ledger) env.OPENCODE_EXPERIMENTAL_TASK_LEDGER = ledger
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { Flag } from ${JSON.stringify(new URL("../../src/flag/flag.ts", import.meta.url).href)}; process.stdout.write(String(Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER))`,
    ],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const code = await proc.exited
  if (code !== 0) throw new Error(await new Response(proc.stderr).text())
  return (await new Response(proc.stdout).text()) === "true"
}

async function claim(input: { task_id: string | null; kind: string; idempotency_key: string }) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { TaskLedger } from ${JSON.stringify(new URL("../../src/session/task-ledger.ts", import.meta.url).href)}
        import { Database } from ${JSON.stringify(new URL("../../src/storage/db.ts", import.meta.url).href)}
        const input = JSON.parse(process.env.COMMAND_INPUT)
        const row = Database.transaction((tx) => TaskLedger.claim(tx, input), { behavior: "immediate" })
        console.log(JSON.stringify(row))
        Database.close()
      `,
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, COMMAND_INPUT: JSON.stringify(input) },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const code = await proc.exited
  if (code !== 0) throw new Error(await new Response(proc.stderr).text())
  return TaskLedger.Command.parse(JSON.parse((await new Response(proc.stdout).text()).trim()))
}

async function event(taskID: string, type: string) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { TaskLedger } from ${JSON.stringify(new URL("../../src/session/task-ledger.ts", import.meta.url).href)}
        import { Database } from ${JSON.stringify(new URL("../../src/storage/db.ts", import.meta.url).href)}
        const row = Database.transaction(
          (tx) => TaskLedger.append(tx, process.env.TASK_ID, [{ type: process.env.EVENT_TYPE }])[0],
          { behavior: "immediate" },
        )
        console.log(JSON.stringify(row))
        Database.close()
      `,
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, TASK_ID: taskID, EVENT_TYPE: type },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const code = await proc.exited
  if (code !== 0) throw new Error(await new Response(proc.stderr).text())
  return TaskLedger.Event.parse(JSON.parse((await new Response(proc.stdout).text()).trim()))
}

function failure(column: "id" | "idempotency_key") {
  const sqlite = new SQLite(":memory:")
  sqlite.exec("CREATE TABLE task_command (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE)")
  sqlite.exec("INSERT INTO task_command VALUES ('command_existing', 'source:existing')")
  const err = (() => {
    try {
      sqlite.exec(
        column === "id"
          ? "INSERT INTO task_command VALUES ('command_existing', 'source:other')"
          : "INSERT INTO task_command VALUES ('command_other', 'source:existing')",
      )
    } catch (cause) {
      return cause
    }
  })()
  sqlite.close(false)
  if (!err) throw new Error("expected sqlite constraint")
  return err
}

function adapter(err: unknown, row: TaskLedger.Command) {
  const state = { reads: 0 }
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            get: () => (state.reads++ === 0 ? undefined : row),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => ({
          get: () => {
            throw err
          },
        }),
      }),
    }),
  } as unknown as Database.TxOrDb
}

describe("task ledger flag", () => {
  test("defaults to false", async () => {
    expect(await flag()).toBe(false)
  })

  test("accepts true and one from the dedicated variable", async () => {
    expect(await Promise.all(["true", "1"].map((value) => flag(undefined, value)))).toEqual([true, true])
  })

  test("keeps false and zero disabled without the global variable", async () => {
    expect(await Promise.all(["false", "0"].map((value) => flag(undefined, value)))).toEqual([false, false])
  })

  test("accepts true and one from the global variable", async () => {
    expect(await Promise.all(["true", "1"].map((value) => flag(value, "false")))).toEqual([true, true])
  })
})

describe("task ledger schema", () => {
  test("migrates existing task, revision, and stop rows without inventing events", () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec("PRAGMA foreign_keys = ON")
    const db = drizzle({ client: sqlite })
    migrate(db, journal(20260723160000))
    sqlite.exec(`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES ('project_old', '/old', 1, 1, '[]');
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated
      ) VALUES ('session_old', 'project_old', 'old', '/old', 'Old', '1', 1, 1);
      INSERT INTO session_task (
        id, session_id, title, status, current_revision_id, source_type, source_ref, time_created, time_updated
      ) VALUES ('task_old', 'session_old', 'Old task', 'running', NULL, 'user', '{}', 1, 1);
      INSERT INTO task_revision (
        id, task_id, version, previous_id, status, title, body, body_hash, workflow, time_created
      ) VALUES
        ('revision_prev', 'task_old', 1, NULL, 'archived', 'Previous', '# Previous', '${"b".repeat(64)}', '{}', 1),
        ('revision_old', 'task_old', 2, 'revision_prev', 'active', 'Old', '# Old', '${"a".repeat(64)}', '{}', 2);
      UPDATE session_task SET current_revision_id = 'revision_old' WHERE id = 'task_old';
      INSERT INTO task_revision_stop (
        revision_id, child_session_id, run_id, action_id, state, reason, time_created
      ) VALUES ('revision_old', 'session_child', 'run_old', 'action_old', 'planned', 'revision', 1);
    `)
    migrate(db, journal(20260723163000))
    sqlite.exec(`
      INSERT INTO task_requirement (
        id, task_id, version, source_refs, body_ref, body_hash, constraints, acceptance, created_by, time_created
      ) VALUES (
        'requirement_old', 'task_old', 1, '[]', 'task-revision://revision_old', '${"a".repeat(64)}',
        '{}', '[]', 'migration', 2
      );
      UPDATE session_task
      SET requirement_id = 'requirement_old', last_event_seq = 1
      WHERE id = 'task_old';
      UPDATE task_revision
      SET requirement_id = 'requirement_old', spec_ref = 'resource_old'
      WHERE id = 'revision_old';
      INSERT INTO task_command (
        id, task_id, kind, idempotency_key, status, result_ref, time_created, time_applied
      ) VALUES ('command_old', 'task_old', 'task.create', 'old:create', 'applied', 'task_old', 2, 2);
      INSERT INTO task_resource (
        id, task_id, revision_id, kind, uri, hash, size, producer_type, producer_id, visibility, lifecycle, time_created
      ) VALUES (
        'resource_old', 'task_old', 'revision_old', 'spec', 'task-revision://revision_old',
        '${"a".repeat(64)}', 5, 'migration', 'revision_old', 'task', 'active', 2
      );
      INSERT INTO task_event (
        task_id, seq, id, type, revision_id, command_id, data, resource_refs, time_created
      ) VALUES (
        'task_old', 1, 'event_old', 'task.created', 'revision_old', 'command_old', '{}', '["resource_old"]', 2
      );
    `)
    migrate(db, journal(20260723170000))
    sqlite.exec(
      "DELETE FROM __drizzle_migrations WHERE name = '20260723163000_durable_task_ledger_constraints'",
    )
    expect(
      sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '__old_%'").all(),
    ).toEqual([])
    migrate(db, journal(20260723170000))
    expect(
      sqlite
        .query(
          "SELECT count(*) AS count FROM __drizzle_migrations WHERE name = '20260723163000_durable_task_ledger_constraints'",
        )
        .get(),
    ).toEqual({ count: 1 })
    migrate(db, journal())

    expect(
      sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN (
               'session_task_current_insert',
               'session_task_current_update',
               'task_revision_current_delete',
               'task_revision_current_task_update',
               'task_revision_id_immutable'
             )
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name),
    ).toEqual([
      "session_task_current_insert",
      "session_task_current_update",
      "task_revision_current_delete",
      "task_revision_current_task_update",
      "task_revision_id_immutable",
    ])
    expect(
      sqlite
        .query<{ name: string }, []>("SELECT name FROM __drizzle_migrations ORDER BY created_at")
        .all()
        .map((row) => row.name),
    ).toContain("20260723163000_durable_task_ledger_constraints")
    expect(
      sqlite
        .query("SELECT id, current_revision_id, last_event_seq, schema_version FROM session_task WHERE id = 'task_old'")
        .get(),
    ).toEqual({
      id: "task_old",
      current_revision_id: "revision_old",
      last_event_seq: 1,
      schema_version: 1,
    })
    expect(
      sqlite
        .query("SELECT id, task_id, requirement_id, schema_version FROM task_revision WHERE id = 'revision_old'")
        .get(),
    ).toEqual({
      id: "revision_old",
      task_id: "task_old",
      requirement_id: "requirement_old",
      schema_version: 1,
    })
    expect(
      sqlite.query("SELECT id, previous_id, status FROM task_revision WHERE task_id = 'task_old' ORDER BY version").all(),
    ).toEqual([
      { id: "revision_prev", previous_id: null, status: "archived" },
      { id: "revision_old", previous_id: "revision_prev", status: "active" },
    ])
    expect(sqlite.query("SELECT count(*) AS count FROM task_revision_stop").get()).toEqual({ count: 1 })
    expect(sqlite.query("SELECT id FROM task_requirement").all()).toEqual([{ id: "requirement_old" }])
    expect(sqlite.query("SELECT id FROM task_resource").all()).toEqual([{ id: "resource_old" }])
    expect(sqlite.query("SELECT id FROM task_command").all()).toEqual([{ id: "command_old" }])
    expect(sqlite.query("SELECT id FROM task_event").all()).toEqual([{ id: "event_old" }])
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(() =>
      sqlite.exec("UPDATE session_task SET current_revision_id = 'revision_missing' WHERE id = 'task_old'"),
    ).toThrow()
    expect(() => sqlite.exec("DELETE FROM task_revision WHERE id = 'revision_old'")).toThrow()
    sqlite.exec("DELETE FROM session_task WHERE id = 'task_old'")
    expect(
      ["task_requirement", "task_revision", "task_revision_stop", "task_resource", "task_command", "task_event"].map(
        (table) => sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
      ),
    ).toEqual([0, 0, 0, 0, 0, 0])
    sqlite.close(false)
  })

  test("rolls back a failed constraint rebuild without advancing the journal", () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec("PRAGMA foreign_keys = ON")
    const db = drizzle({ client: sqlite })
    migrate(db, journal(20260723160000))
    sqlite.exec(`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES ('project_rollback', '/rollback', 1, 1, '[]');
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated
      ) VALUES
        ('session_rollback_a', 'project_rollback', 'a', '/rollback', 'A', '1', 1, 1),
        ('session_rollback_b', 'project_rollback', 'b', '/rollback', 'B', '1', 1, 1);
      INSERT INTO session_task (
        id, session_id, title, status, current_revision_id, source_type, source_ref, time_created, time_updated
      ) VALUES
        ('task_rollback_a', 'session_rollback_a', 'A', 'running', NULL, 'user', '{}', 1, 1),
        ('task_rollback_b', 'session_rollback_b', 'B', 'running', NULL, 'user', '{}', 1, 1);
      INSERT INTO task_revision (
        id, task_id, version, previous_id, status, title, body, body_hash, workflow, time_created
      ) VALUES
        ('revision_rollback_a', 'task_rollback_a', 1, NULL, 'active', 'A', '# A', '${"a".repeat(64)}', '{}', 1),
        ('revision_rollback_b', 'task_rollback_b', 1, NULL, 'active', 'B', '# B', '${"b".repeat(64)}', '{}', 1);
      UPDATE session_task SET current_revision_id = 'revision_rollback_a' WHERE id = 'task_rollback_a';
      UPDATE session_task SET current_revision_id = 'revision_rollback_b' WHERE id = 'task_rollback_b';
      INSERT INTO task_revision_stop (
        revision_id, child_session_id, run_id, action_id, state, reason, time_created
      ) VALUES ('revision_rollback_a', 'session_child', 'run_rollback', 'action_rollback', 'planned', 'revision', 1);
    `)
    migrate(db, journal(20260723163000))
    sqlite.exec(`
      INSERT INTO task_resource (
        id, task_id, revision_id, kind, uri, hash, size, producer_type, producer_id, visibility, lifecycle, time_created
      ) VALUES (
        'resource_cross', 'task_rollback_a', 'revision_rollback_b', 'spec', 'memory://cross',
        '${"c".repeat(64)}', 1, 'revision', 'revision_rollback_b', 'task', 'active', 2
      );
    `)
    const before = sqlite
      .query<{ name: string }, []>("SELECT name FROM __drizzle_migrations ORDER BY created_at")
      .all()
      .map((row) => row.name)

    expect(() => migrate(db, journal())).toThrow()
    expect(
      sqlite
        .query<{ name: string }, []>("SELECT name FROM __drizzle_migrations ORDER BY created_at")
        .all()
        .map((row) => row.name),
    ).toEqual(before)
    expect(sqlite.query("SELECT id, task_id, revision_id FROM task_resource").all()).toEqual([
      { id: "resource_cross", task_id: "task_rollback_a", revision_id: "revision_rollback_b" },
    ])
    expect(sqlite.query("SELECT revision_id FROM task_revision_stop").all()).toEqual([
      { revision_id: "revision_rollback_a" },
    ])
    expect(
      sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '__old_%'").all(),
    ).toEqual([])
    expect(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'task_revision_current_delete'")
        .all(),
    ).toEqual([{ name: "task_revision_current_delete" }])
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    sqlite.close(false)
  })

  test("rejects migration when an existing task has a dangling current requirement", () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec("PRAGMA foreign_keys = ON")
    const db = drizzle({ client: sqlite })
    migrate(db, journal(20260723170000))
    sqlite.exec(`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES ('project_bad', '/bad', 1, 1, '[]');
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated
      ) VALUES ('session_bad', 'project_bad', 'bad', '/bad', 'Bad', '1', 1, 1);
      INSERT INTO session_task (
        id, session_id, title, status, current_revision_id, requirement_id, source_type, source_ref,
        time_created, time_updated
      ) VALUES (
        'task_bad', 'session_bad', 'Bad task', 'running', NULL, 'requirement_missing', 'user', '{}', 1, 1
      );
    `)

    expect(() => migrate(db, journal())).toThrow()
    expect(
      sqlite
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'session_task_requirement_update'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    sqlite.close(false)
  })

  test("enforces one requirement version per task and task foreign keys", () =>
    setup(async () => {
      const saved = await task()
      const other = await task()
      const row = {
        id: "requirement_1",
        task_id: saved.task.id,
        version: 1,
        source_refs: [],
        body_ref: `task-revision://${saved.revision.id}`,
        body_hash: saved.revision.body_hash,
        constraints: {},
        acceptance: [],
        created_by: "user" as const,
        confirmed_at: null,
        supersedes_id: null,
        time_created: Date.now(),
      }
      Database.use((db) => db.insert(TaskRequirementTable).values(row).run())
      expect(() =>
        Database.use((db) => db.insert(TaskRequirementTable).values({ ...row, id: "requirement_2" }).run()),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .insert(TaskRequirementTable)
            .values({ ...row, id: "requirement_3", task_id: "task_missing", version: 2 })
            .run(),
        ),
      ).toThrow()
      Database.use((db) =>
        db
          .insert(TaskRequirementTable)
          .values({
            ...row,
            id: "requirement_4",
            version: 2,
            supersedes_id: row.id,
          })
          .run(),
      )
      expect(() =>
        Database.use((db) => db.delete(TaskRequirementTable).where(eq(TaskRequirementTable.id, row.id)).run()),
      ).toThrow()
      Database.use((db) => db.delete(TaskRequirementTable).where(eq(TaskRequirementTable.id, "requirement_4")).run())
      Database.use((db) =>
        db
          .insert(TaskRequirementTable)
          .values({
            ...row,
            id: "requirement_5",
            task_id: other.task.id,
            body_ref: `task-revision://${other.revision.id}`,
            body_hash: other.revision.body_hash,
          })
          .run(),
      )
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRequirementTable)
            .set({ supersedes_id: row.id })
            .where(eq(TaskRequirementTable.id, "requirement_5"))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(SessionTaskTable)
            .set({ requirement_id: "requirement_5" })
            .where(eq(SessionTaskTable.id, saved.task.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(SessionTaskTable)
            .set({ requirement_id: "requirement_missing" })
            .where(eq(SessionTaskTable.id, saved.task.id))
            .run(),
        ),
      ).toThrow()
      Database.use((db) =>
        db.update(SessionTaskTable).set({ requirement_id: row.id }).where(eq(SessionTaskTable.id, saved.task.id)).run(),
      )
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRevisionTable)
            .set({ requirement_id: "requirement_5" })
            .where(eq(TaskRevisionTable.id, saved.revision.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRequirementTable)
            .set({ task_id: other.task.id })
            .where(eq(TaskRequirementTable.id, row.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .update(TaskRequirementTable)
            .set({ id: "requirement_renamed" })
            .where(eq(TaskRequirementTable.id, row.id))
            .run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) => db.delete(TaskRequirementTable).where(eq(TaskRequirementTable.id, row.id)).run()),
      ).toThrow()
      const session = await Session.create({})
      const insert = {
        id: "task_insert_cross",
        session_id: session.id,
        title: "Cross task requirement",
        status: "running" as const,
        current_revision_id: null,
        requirement_id: "requirement_5",
        status_reason: null,
        last_event_seq: 0,
        checkpoint_id: null,
        schema_version: 1,
        source_type: "user" as const,
        source_ref: {},
        time_created: Date.now(),
        time_updated: Date.now(),
      }
      expect(() => Database.use((db) => db.insert(SessionTaskTable).values(insert).run())).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .insert(SessionTaskTable)
            .values({ ...insert, id: "task_insert_missing", requirement_id: "requirement_missing" })
            .run(),
        ),
      ).toThrow()
      Database.use((db) =>
        db.update(SessionTaskTable).set({ requirement_id: null }).where(eq(SessionTaskTable.id, saved.task.id)).run(),
      )
      expect(() =>
        Database.use((db) => db.delete(TaskRequirementTable).where(eq(TaskRequirementTable.id, row.id)).run()),
      ).not.toThrow()
    }))

  test("enforces resource identity, event sequence, and command idempotency", () =>
    setup(async () => {
      const saved = await task()
      const other = await task()
      const command = {
        id: "command_1",
        task_id: saved.task.id,
        kind: "task.create",
        idempotency_key: "task:create:source",
        status: "applied" as const,
        result_ref: saved.task.id,
        time_created: Date.now(),
        time_applied: Date.now(),
      }
      Database.use((db) => db.insert(TaskCommandTable).values(command).run())
      expect(() =>
        Database.use((db) =>
          db.insert(TaskCommandTable).values({ ...command, id: "command_2", task_id: null }).run(),
        ),
      ).toThrow()

      const resource = {
        id: "resource_1",
        task_id: saved.task.id,
        revision_id: saved.revision.id,
        kind: "spec" as const,
        uri: `task-revision://${saved.revision.id}`,
        hash: saved.revision.body_hash,
        size: saved.revision.body.length,
        summary: saved.revision.title,
        producer_type: "revision" as const,
        producer_id: saved.revision.id,
        visibility: "task" as const,
        lifecycle: "active" as const,
        time_created: Date.now(),
      }
      Database.use((db) => db.insert(TaskResourceTable).values(resource).run())
      expect(() =>
        Database.use((db) => db.insert(TaskResourceTable).values({ ...resource, id: "resource_2" }).run()),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db
            .insert(TaskResourceTable)
            .values({ ...resource, id: "resource_3", revision_id: other.revision.id })
            .run(),
        ),
      ).toThrow()

      const event = {
        task_id: saved.task.id,
        seq: 1,
        id: "event_1",
        type: "task.created",
        revision_id: saved.revision.id,
        command_id: command.id,
        data: {},
        resource_refs: [resource.id],
        time_created: Date.now(),
      }
      Database.use((db) => db.insert(TaskEventTable).values(event).run())
      expect(() =>
        Database.use((db) => db.insert(TaskEventTable).values({ ...event, id: "event_2" }).run()),
      ).toThrow()
      expect(() =>
        Database.use((db) =>
          db.insert(TaskEventTable).values({ ...event, seq: 2, id: "event_3", revision_id: other.revision.id }).run(),
        ),
      ).toThrow()
      const foreign = { ...command, id: "command_3", task_id: other.task.id, idempotency_key: "task:create:other" }
      Database.use((db) => db.insert(TaskCommandTable).values(foreign).run())
      expect(() =>
        Database.use((db) =>
          db.insert(TaskEventTable).values({ ...event, seq: 2, id: "event_4", command_id: foreign.id }).run(),
        ),
      ).toThrow()
      expect(() =>
        Database.use((db) => db.delete(SessionTaskTable).where(eq(SessionTaskTable.id, saved.task.id)).run()),
      ).not.toThrow()
      expect(
        Database.use((db) => db.select().from(TaskEventTable).where(eq(TaskEventTable.task_id, saved.task.id)).all()),
      ).toEqual([])
    }))

  test("exposes every ledger foreign key and unique index in sqlite metadata", () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec("PRAGMA foreign_keys = ON")
    migrate(drizzle({ client: sqlite }), journal())
    const fks = ["task_requirement", "task_revision", "task_resource", "task_command", "task_event"].flatMap((table) =>
      sqlite
        .query<{ from: string; table: string; to: string }, []>(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => `${table}.${row.from}->${row.table}.${row.to}`),
    )
    expect(fks).toEqual(
      expect.arrayContaining([
        "task_requirement.task_id->task_requirement.task_id",
        "task_requirement.supersedes_id->task_requirement.id",
        "task_revision.task_id->task_requirement.task_id",
        "task_revision.requirement_id->task_requirement.id",
        "task_resource.task_id->task_revision.task_id",
        "task_resource.revision_id->task_revision.id",
        "task_event.task_id->task_command.task_id",
        "task_event.command_id->task_command.id",
        "task_event.task_id->task_revision.task_id",
        "task_event.revision_id->task_revision.id",
      ]),
    )
    const unique = ["task_requirement", "task_revision", "task_resource", "task_command", "task_event"].flatMap((table) =>
      sqlite
        .query<{ name: string; unique: number }, []>(`PRAGMA index_list(${table})`)
        .all()
        .filter((row) => row.unique === 1)
        .map((row) => row.name),
    )
    expect(unique).toEqual(
      expect.arrayContaining([
        "task_requirement_task_version_unique_idx",
        "task_requirement_task_id_unique_idx",
        "task_revision_task_version_unique_idx",
        "task_revision_task_id_unique_idx",
        "task_revision_one_active_idx",
        "task_resource_identity_unique_idx",
        "task_command_idempotency_unique_idx",
        "task_command_task_id_unique_idx",
        "task_event_id_unique_idx",
      ]),
    )
    expect(
      sqlite
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%requirement%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual([
      "session_task_requirement_insert",
      "session_task_requirement_update",
      "task_requirement_current_delete",
      "task_requirement_identity_immutable",
    ])
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    sqlite.close(false)
  })
})

describe("task ledger contracts", () => {
  test("rejects unknown fields, malformed hashes, kinds, and lifecycle values", () => {
    const row = {
      id: "resource_1",
      task_id: "task_1",
      revision_id: null,
      kind: "spec" as const,
      uri: "memory://spec",
      hash: "a".repeat(64),
      size: 1,
      summary: null,
      producer_type: "revision" as const,
      producer_id: "revision_1",
      visibility: "task" as const,
      lifecycle: "active" as const,
      time_created: 1,
    }
    expect(TaskLedger.Resource.parse(row)).toEqual(row)
    expect(TaskLedger.Resource.safeParse({ ...row, extra: true }).success).toBe(false)
    expect(TaskLedger.Resource.safeParse({ ...row, hash: "z".repeat(64) }).success).toBe(false)
    expect(TaskLedger.Resource.safeParse({ ...row, kind: "artifact" }).success).toBe(false)
    expect(TaskLedger.Resource.safeParse({ ...row, lifecycle: "deleted" }).success).toBe(false)
  })

  test("lists isolated requirement history and finds the latest or requested version", () =>
    setup(async () => {
      const saved = await task()
      const other = await task()
      expect(TaskLedger.requirements(saved.task.id)).toEqual([])
      const base = {
        task_id: saved.task.id,
        source_refs: ["message_1"],
        body_ref: `task-revision://${saved.revision.id}`,
        body_hash: saved.revision.body_hash,
        constraints: {},
        acceptance: [],
        created_by: "user" as const,
        confirmed_at: null,
        supersedes_id: null,
        time_created: 1,
      }
      Database.use((db) =>
        db
          .insert(TaskRequirementTable)
          .values([
            { ...base, id: "requirement_1", version: 1 },
            { ...base, id: "requirement_2", version: 2, supersedes_id: "requirement_1", time_created: 2 },
          ])
          .run(),
      )
      Database.use((db) =>
        db
          .insert(TaskRequirementTable)
          .values({
            ...base,
            id: "requirement_other",
            task_id: other.task.id,
            body_ref: `task-revision://${other.revision.id}`,
            body_hash: other.revision.body_hash,
            version: 1,
          })
          .run(),
      )
      expect(TaskLedger.requirements(saved.task.id).map((item) => [item.id, item.version])).toEqual([
        ["requirement_1", 1],
        ["requirement_2", 2],
      ])
      expect(TaskLedger.requirements(other.task.id).map((item) => item.id)).toEqual(["requirement_other"])
      expect(TaskLedger.findRequirement(saved.task.id)?.id).toBe("requirement_2")
      expect(TaskLedger.findRequirement(saved.task.id, "requirement_1")?.version).toBe(1)
      expect(TaskLedger.findRequirement(saved.task.id, "requirement_missing")).toBeUndefined()
      expect(() => TaskLedger.requirements("invalid")).toThrow()
      expect(() => TaskLedger.findRequirement("invalid")).toThrow()
      Database.use((db) =>
        db
          .update(TaskRequirementTable)
          .set({ body_hash: "z".repeat(64) })
          .where(eq(TaskRequirementTable.id, "requirement_2"))
          .run(),
      )
      expect(() => TaskLedger.requirements(saved.task.id)).toThrow()
    }))

  test("lists resources in stable creation and id order and parses stored output", () =>
    setup(async () => {
      const saved = await task()
      const base = {
        task_id: saved.task.id,
        revision_id: saved.revision.id,
        kind: "spec" as const,
        uri: "memory://spec",
        hash: saved.revision.body_hash,
        size: 1,
        summary: null,
        producer_type: "revision" as const,
        producer_id: saved.revision.id,
        visibility: "task" as const,
        lifecycle: "active" as const,
        time_created: 1,
      }
      Database.use((db) =>
        db
          .insert(TaskResourceTable)
          .values([
            { ...base, id: "resource_b", uri: "memory://b" },
            { ...base, id: "resource_a", uri: "memory://a" },
            { ...base, id: "resource_c", uri: "memory://c", time_created: 2 },
          ])
          .run(),
      )
      expect(TaskLedger.listResources(saved.task.id).map((item) => item.id)).toEqual([
        "resource_a",
        "resource_b",
        "resource_c",
      ])
      Database.use((db) =>
        db
          .update(TaskResourceTable)
          .set({ lifecycle: "deleted" as "active" })
          .where(eq(TaskResourceTable.id, "resource_c"))
          .run(),
      )
      expect(() => TaskLedger.listResources(saved.task.id)).toThrow()
    }))

  test("finds commands by idempotency key and rejects malformed stored output", () =>
    setup(async () => {
      const saved = await task()
      Database.use((db) =>
        db
          .insert(TaskCommandTable)
          .values({
            id: "command_1",
            task_id: saved.task.id,
            kind: "task.create",
            idempotency_key: "create:1",
            status: "applied",
            result_ref: saved.task.id,
            time_created: 1,
            time_applied: 2,
          })
          .run(),
      )
      expect(TaskLedger.findCommand("create:1")?.id).toBe("command_1")
      expect(TaskLedger.findCommand("missing")).toBeUndefined()
      Database.use((db) =>
        db
          .update(TaskCommandTable)
          .set({ status: "broken" as "applied" })
          .where(eq(TaskCommandTable.id, "command_1"))
          .run(),
      )
      expect(() => TaskLedger.findCommand("create:1")).toThrow()
    }))

  test("lists events with an exclusive bounded cursor without duplicates", () =>
    setup(async () => {
      const saved = await task()
      Database.use((db) =>
        db
          .insert(TaskEventTable)
          .values(
            [3, 1, 2].map((seq) => ({
              task_id: saved.task.id,
              seq,
              id: `event_${seq}`,
              type: "task.updated",
              revision_id: saved.revision.id,
              command_id: null,
              data: { seq },
              resource_refs: [],
              time_created: 4 - seq,
            })),
          )
          .run(),
      )
      const first = TaskLedger.listEvents(saved.task.id, 0, 2)
      const next = TaskLedger.listEvents(saved.task.id, first.at(-1)!.seq, 2)
      expect(first.map((item) => item.seq)).toEqual([1, 2])
      expect(next.map((item) => item.seq)).toEqual([3])
      expect(new Set([...first, ...next].map((item) => item.id)).size).toBe(3)
      expect(() => TaskLedger.listEvents(saved.task.id, -1)).toThrow()
      expect(() => TaskLedger.listEvents(saved.task.id, 0, 501)).toThrow()
    }))
})

describe("task ledger commands", () => {
  test("replays duplicate claims and applied results without adding rows", () =>
    setup(async () => {
      const saved = await task()
      const input = {
        task_id: saved.task.id,
        kind: "task.create",
        idempotency_key: `session:${saved.task.session_id}:create`,
      }
      const first = Database.transaction((tx) => TaskLedger.claim(tx, input), { behavior: "immediate" })
      const repeat = Database.transaction((tx) => TaskLedger.claim(tx, input), { behavior: "immediate" })
      expect(repeat.id).toBe(first.id)
      const applied = Database.transaction((tx) => TaskLedger.apply(tx, first.id, "task://created"), {
        behavior: "immediate",
      })
      expect(applied).toMatchObject({ status: "applied", result_ref: "task://created" })
      expect(Database.transaction((tx) => TaskLedger.claim(tx, input), { behavior: "immediate" })).toEqual(applied)
      expect(
        Database.transaction((tx) => TaskLedger.apply(tx, first.id, "task://created"), { behavior: "immediate" }),
      ).toEqual(applied)
      expect(
        Database.use((db) =>
          db.select().from(TaskCommandTable).where(eq(TaskCommandTable.idempotency_key, input.idempotency_key)).all(),
        ),
      ).toHaveLength(1)
    }))

  test("rejects task and kind identity drift for the same stable key", () =>
    setup(async () => {
      const saved = await task()
      const other = await task()
      const input = {
        task_id: saved.task.id,
        kind: "task.create",
        idempotency_key: "source:session:message:create",
      }
      Database.transaction((tx) => TaskLedger.claim(tx, input), { behavior: "immediate" })
      expect(() =>
        Database.transaction((tx) => TaskLedger.claim(tx, { ...input, task_id: other.task.id }), {
          behavior: "immediate",
        }),
      ).toThrow(TaskLedger.Conflict)
      expect(() =>
        Database.transaction((tx) => TaskLedger.claim(tx, { ...input, kind: "task.revise" }), {
          behavior: "immediate",
        }),
      ).toThrow(TaskLedger.Conflict)
    }))

  test("allows only accepted commands to become applied", () =>
    setup(async () => {
      const saved = await task()
      const row = {
        id: "command_rejected",
        task_id: saved.task.id,
        kind: "task.create",
        idempotency_key: "source:rejected",
        status: "rejected" as const,
        result_ref: null,
        time_created: 1,
        time_applied: null,
      }
      Database.use((db) => db.insert(TaskCommandTable).values(row).run())
      expect(() =>
        Database.transaction((tx) => TaskLedger.apply(tx, row.id, "task://created"), { behavior: "immediate" }),
      ).toThrow(TaskLedger.Conflict)
      expect(() =>
        Database.transaction((tx) => TaskLedger.apply(tx, "command_missing"), { behavior: "immediate" }),
      ).toThrow(TaskLedger.Conflict)
      const accepted = Database.transaction(
        (tx) =>
          TaskLedger.claim(tx, {
            task_id: saved.task.id,
            kind: "task.create",
            idempotency_key: "source:accepted",
          }),
        { behavior: "immediate" },
      )
      Database.transaction((tx) => TaskLedger.apply(tx, accepted.id, "task://created"), { behavior: "immediate" })
      expect(() =>
        Database.transaction((tx) => TaskLedger.apply(tx, accepted.id, "task://different"), {
          behavior: "immediate",
        }),
      ).toThrow(TaskLedger.Conflict)
    }))

  test("serializes concurrent claims onto one command row", () =>
    setup(async () => {
      const saved = await task()
      const input = {
        task_id: saved.task.id,
        kind: "task.create",
        idempotency_key: "source:concurrent:create",
      }
      const rows = await Promise.all([claim(input), claim(input)])
      expect(rows[0]!.id).toBe(rows[1]!.id)
      expect(
        Database.use((db) =>
          db.select().from(TaskCommandTable).where(eq(TaskCommandTable.idempotency_key, input.idempotency_key)).all(),
        ),
      ).toHaveLength(1)
    }))

  test("propagates non-idempotency insert errors without replaying a row", () => {
    const input = {
      task_id: "task_existing",
      kind: "task.create",
      idempotency_key: "source:existing",
    }
    const row = TaskLedger.Command.parse({
      id: "command_existing",
      ...input,
      status: "accepted",
      result_ref: null,
      time_created: 1,
      time_applied: null,
    })
    const err = failure("id")
    const caught = (() => {
      try {
        TaskLedger.claim(adapter(err, row), input)
      } catch (cause) {
        return cause
      }
    })()
    expect(caught).toBe(err)
  })

  test("rechecks identity only after the idempotency unique constraint", () => {
    const input = {
      task_id: "task_existing",
      kind: "task.create",
      idempotency_key: "source:existing",
    }
    const row = TaskLedger.Command.parse({
      id: "command_existing",
      ...input,
      status: "accepted",
      result_ref: null,
      time_created: 1,
      time_applied: null,
    })
    const err = failure("idempotency_key")
    expect(TaskLedger.claim(adapter(err, row), input)).toEqual(row)
    expect(() => TaskLedger.claim(adapter(err, { ...row, kind: "task.revise" }), input)).toThrow(TaskLedger.Conflict)
  })
})

describe("task ledger event sequence", () => {
  test("appends a strict batch with continuous sequence and references", () =>
    setup(async () => {
      const saved = await task()
      const command = {
        id: "command_event",
        task_id: saved.task.id,
        kind: "task.update",
        idempotency_key: "source:event",
        status: "accepted" as const,
        result_ref: null,
        time_created: 1,
        time_applied: null,
      }
      const resource = {
        id: "resource_event",
        task_id: saved.task.id,
        revision_id: saved.revision.id,
        kind: "spec" as const,
        uri: "memory://event",
        hash: saved.revision.body_hash,
        size: 1,
        summary: null,
        producer_type: "revision" as const,
        producer_id: saved.revision.id,
        visibility: "task" as const,
        lifecycle: "active" as const,
        time_created: 1,
      }
      Database.use((db) => {
        db.insert(TaskCommandTable).values(command).run()
        db.insert(TaskResourceTable).values(resource).run()
      })
      const rows = Database.transaction(
        (tx) =>
          TaskLedger.append(tx, saved.task.id, [
            {
              type: "revision.updated",
              revision_id: saved.revision.id,
              command_id: command.id,
              data: { version: 1 },
              resource_refs: [resource.id],
            },
            { type: "projection.requested" },
          ]),
        { behavior: "immediate" },
      )
      expect(rows.map((row) => row.seq)).toEqual([1, 2])
      expect(rows[0]).toMatchObject({
        task_id: saved.task.id,
        revision_id: saved.revision.id,
        command_id: command.id,
        resource_refs: [resource.id],
      })
      expect(
        Database.use((db) =>
          db
            .select({ seq: SessionTaskTable.last_event_seq })
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, saved.task.id))
            .get(),
        ),
      ).toEqual({ seq: 2 })
    }))

  test("rejects missing tasks and invalid event input without advancing sequence", () =>
    setup(async () => {
      const saved = await task()
      expect(() =>
        Database.transaction((tx) => TaskLedger.append(tx, "task_missing", [{ type: "task.updated" }]), {
          behavior: "immediate",
        }),
      ).toThrow(TaskLedger.Conflict)
      expect(() =>
        Database.transaction((tx) => TaskLedger.append(tx, saved.task.id, []), { behavior: "immediate" }),
      ).toThrow()
      expect(() =>
        Database.transaction(
          (tx) => TaskLedger.append(tx, saved.task.id, [{ type: "task.updated", resource_refs: ["invalid"] }]),
          { behavior: "immediate" },
        ),
      ).toThrow()
      expect(TaskLedger.listEvents(saved.task.id)).toEqual([])
    }))

  test("rolls back task sequence and the whole batch when an event insert fails", () =>
    setup(async () => {
      const saved = await task()
      expect(() =>
        Database.transaction(
          (tx) =>
            TaskLedger.append(tx, saved.task.id, [
              { type: "task.updated" },
              { type: "task.failed", command_id: "command_missing" },
            ]),
          { behavior: "immediate" },
        ),
      ).toThrow()
      expect(TaskLedger.listEvents(saved.task.id)).toEqual([])
      expect(
        Database.use((db) =>
          db
            .select({ seq: SessionTaskTable.last_event_seq })
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, saved.task.id))
            .get(),
        ),
      ).toEqual({ seq: 0 })
    }))

  test("serializes concurrent writers without sequence gaps", () =>
    setup(async () => {
      const saved = await task()
      const rows = await Promise.all([event(saved.task.id, "writer.one"), event(saved.task.id, "writer.two")])
      expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual([1, 2])
      expect(TaskLedger.listEvents(saved.task.id).map((row) => row.seq)).toEqual([1, 2])
    }))

  test("skips append when a command replay is already applied", () =>
    setup(async () => {
      const saved = await task()
      const run = () =>
        Database.transaction(
          (tx) => {
            const command = TaskLedger.claim(tx, {
              task_id: saved.task.id,
              kind: "task.update",
              idempotency_key: "source:replay:event",
            })
            if (command.status === "applied") return command
            TaskLedger.append(tx, saved.task.id, [{ type: "task.updated", command_id: command.id }])
            return TaskLedger.apply(tx, command.id, "task://updated")
          },
          { behavior: "immediate" },
        )
      expect(run().status).toBe("applied")
      expect(run().status).toBe("applied")
      expect(TaskLedger.listEvents(saved.task.id)).toHaveLength(1)
    }))
})
