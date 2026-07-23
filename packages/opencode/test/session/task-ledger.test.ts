import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import {
  SessionTaskTable,
  TaskCommandTable,
  TaskEventTable,
  TaskRequirementTable,
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

describe("task ledger schema", () => {
  test("defaults existing task and revision rows to schema version one", () =>
    setup(async () => {
      const saved = await task()
      const row = Database.use((db) =>
        db.select().from(SessionTaskTable).where(eq(SessionTaskTable.id, saved.task.id)).get(),
      )
      expect(row?.last_event_seq).toBe(0)
      expect(row?.schema_version).toBe(1)
      expect(saved.revision.schema_version).toBe(1)
    }))

  test("enforces one requirement version per task and task foreign keys", () =>
    setup(async () => {
      const saved = await task()
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
    }))

  test("enforces resource identity, event sequence, and command idempotency", () =>
    setup(async () => {
      const saved = await task()
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
    }))
})
