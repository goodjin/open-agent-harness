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
      ) VALUES ('revision_old', 'task_old', 1, NULL, 'active', 'Old', '# Old', '${"a".repeat(64)}', '{}', 1);
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
    migrate(db, journal())

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
    expect(sqlite.query("SELECT count(*) AS count FROM task_revision_stop").get()).toEqual({ count: 1 })
    expect(sqlite.query("SELECT id FROM task_requirement").all()).toEqual([{ id: "requirement_old" }])
    expect(sqlite.query("SELECT id FROM task_resource").all()).toEqual([{ id: "resource_old" }])
    expect(sqlite.query("SELECT id FROM task_command").all()).toEqual([{ id: "command_old" }])
    expect(sqlite.query("SELECT id FROM task_event").all()).toEqual([{ id: "event_old" }])
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    sqlite.exec("DELETE FROM session_task WHERE id = 'task_old'")
    expect(
      ["task_requirement", "task_revision", "task_revision_stop", "task_resource", "task_command", "task_event"].map(
        (table) => sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
      ),
    ).toEqual([0, 0, 0, 0, 0, 0])
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
