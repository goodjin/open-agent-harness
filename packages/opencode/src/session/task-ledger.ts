import z from "zod"
import { Database, and, asc, desc, eq, gt } from "../storage/db"
import { TaskCommandTable, TaskEventTable, TaskRequirementTable, TaskResourceTable } from "./session.sql"

export namespace TaskLedger {
  const ID = (prefix: string) => z.string().min(prefix.length + 2).startsWith(`${prefix}_`)
  const TaskID = ID("task")
  const RevisionID = ID("revision")
  const Hash = z.string().regex(/^[0-9a-f]{64}$/)
  const Time = z.number().int().nonnegative()
  const Data = z.record(z.string(), z.unknown())

  export const Requirement = z
    .object({
      id: ID("requirement"),
      task_id: TaskID,
      version: z.number().int().positive(),
      source_refs: z.array(z.string().min(1)),
      body_ref: z.string().min(1),
      body_hash: Hash,
      constraints: Data,
      acceptance: z.array(Data),
      created_by: z.enum(["user", "agent", "migration"]),
      confirmed_at: Time.nullable(),
      supersedes_id: ID("requirement").nullable(),
      time_created: Time,
    })
    .strict()
  export type Requirement = z.infer<typeof Requirement>

  export const Resource = z
    .object({
      id: ID("resource"),
      task_id: TaskID,
      revision_id: RevisionID.nullable(),
      kind: z.enum(["requirement", "spec", "plan"]),
      uri: z.string().min(1),
      hash: Hash,
      size: z.number().int().nonnegative(),
      summary: z.string().nullable(),
      producer_type: z.enum(["requirement", "revision", "assignment", "migration"]),
      producer_id: z.string().min(1),
      visibility: z.enum(["private", "task", "project", "exportable"]),
      lifecycle: z.enum(["active", "archived", "tombstoned"]),
      time_created: Time,
    })
    .strict()
  export type Resource = z.infer<typeof Resource>

  export const Command = z
    .object({
      id: ID("command"),
      task_id: TaskID.nullable(),
      kind: z.string().min(1),
      idempotency_key: z.string().min(1),
      status: z.enum(["accepted", "applied", "rejected"]),
      result_ref: z.string().nullable(),
      time_created: Time,
      time_applied: Time.nullable(),
    })
    .strict()
  export type Command = z.infer<typeof Command>

  export const Event = z
    .object({
      task_id: TaskID,
      seq: z.number().int().positive(),
      id: ID("event"),
      type: z.string().min(1),
      revision_id: RevisionID.nullable(),
      command_id: ID("command").nullable(),
      data: Data,
      resource_refs: z.array(ID("resource")),
      time_created: Time,
    })
    .strict()
  export type Event = z.infer<typeof Event>

  export const Snapshot = z
    .object({
      task_id: TaskID,
      requirement: Requirement.nullable(),
      resources: z.array(Resource),
      events: z.array(Event),
    })
    .strict()
  export type Snapshot = z.infer<typeof Snapshot>

  export function requirements(taskID: string) {
    const id = TaskID.parse(taskID)
    return Database.use((db) =>
      db
        .select()
        .from(TaskRequirementTable)
        .where(eq(TaskRequirementTable.task_id, id))
        .orderBy(asc(TaskRequirementTable.version), asc(TaskRequirementTable.id))
        .all(),
    ).map((row) => Requirement.parse(row))
  }

  export function findRequirement(taskID: string, id?: string) {
    const input = z
      .object({ task_id: TaskID, id: ID("requirement").optional() })
      .strict()
      .parse({
        task_id: taskID,
        id,
      })
    const where = input.id
      ? and(eq(TaskRequirementTable.task_id, input.task_id), eq(TaskRequirementTable.id, input.id))
      : eq(TaskRequirementTable.task_id, input.task_id)
    const row = Database.use((db) =>
      db
        .select()
        .from(TaskRequirementTable)
        .where(where)
        .orderBy(desc(TaskRequirementTable.version), asc(TaskRequirementTable.id))
        .limit(1)
        .get(),
    )
    return row ? Requirement.parse(row) : undefined
  }

  export function listResources(taskID: string) {
    const id = TaskID.parse(taskID)
    return Database.use((db) =>
      db
        .select()
        .from(TaskResourceTable)
        .where(eq(TaskResourceTable.task_id, id))
        .orderBy(asc(TaskResourceTable.time_created), asc(TaskResourceTable.id))
        .all(),
    ).map((row) => Resource.parse(row))
  }

  export function findCommand(key: string) {
    const id = z.string().min(1).parse(key)
    const row = Database.use((db) =>
      db.select().from(TaskCommandTable).where(eq(TaskCommandTable.idempotency_key, id)).limit(1).get(),
    )
    return row ? Command.parse(row) : undefined
  }

  export function listEvents(taskID: string, after = 0, limit = 100) {
    const input = z
      .object({
        task_id: TaskID,
        after: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(500),
      })
      .strict()
      .parse({ task_id: taskID, after, limit })
    return Database.use((db) =>
      db
        .select()
        .from(TaskEventTable)
        .where(and(eq(TaskEventTable.task_id, input.task_id), gt(TaskEventTable.seq, input.after)))
        .orderBy(asc(TaskEventTable.seq))
        .limit(input.limit)
        .all(),
    ).map((row) => Event.parse(row))
  }
}
