import z from "zod"
import { randomUUID } from "crypto"
import { SQLiteError } from "bun:sqlite"
import { Database, and, asc, desc, eq, gt } from "../storage/db"
import {
  SessionTaskTable,
  TaskCommandTable,
  TaskEventTable,
  TaskRequirementTable,
  TaskResourceTable,
} from "./session.sql"

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

  export class Conflict extends Error {}

  const Claim = z
    .object({
      task_id: TaskID.nullable(),
      kind: z.string().min(1),
      idempotency_key: z.string().min(1),
    })
    .strict()
  const NewEvent = z
    .object({
      type: z.string().min(1),
      revision_id: RevisionID.nullable().default(null),
      command_id: ID("command").nullable().default(null),
      data: Data.default({}),
      resource_refs: z.array(ID("resource")).default([]),
    })
    .strict()

  function duplicate(err: unknown) {
    if (!(err instanceof SQLiteError) || err.code !== "SQLITE_CONSTRAINT_UNIQUE") return false
    return (
      err.message
        .split(":")
        .at(-1)
        ?.split(",")
        .map((item) => item.trim())
        .includes("task_command.idempotency_key") === true
    )
  }

  export function claim(tx: Database.Transaction, input: z.input<typeof Claim>) {
    const parsed = Claim.parse(input)
    const find = () =>
      tx
        .select()
        .from(TaskCommandTable)
        .where(eq(TaskCommandTable.idempotency_key, parsed.idempotency_key))
        .limit(1)
        .get()
    const check = (row: typeof TaskCommandTable.$inferSelect) => {
      if (row.task_id !== parsed.task_id || row.kind !== parsed.kind) throw new Conflict("task_command_identity_drift")
      return Command.parse(row)
    }
    const current = find()
    if (current) return check(current)
    try {
      return Command.parse(
        tx
          .insert(TaskCommandTable)
          .values({
            id: `command_${randomUUID()}`,
            task_id: parsed.task_id,
            kind: parsed.kind,
            idempotency_key: parsed.idempotency_key,
            status: "accepted",
            result_ref: null,
            time_created: Date.now(),
            time_applied: null,
          })
          .returning()
          .get(),
      )
    } catch (err) {
      if (!duplicate(err)) throw err
      const row = find()
      if (!row) throw err
      return check(row)
    }
  }

  export function apply(tx: Database.Transaction, commandID: string, resultRef?: string) {
    const id = ID("command").parse(commandID)
    const result = z.string().min(1).optional().parse(resultRef)
    const row = tx
      .update(TaskCommandTable)
      .set({ status: "applied", result_ref: result ?? null, time_applied: Date.now() })
      .where(and(eq(TaskCommandTable.id, id), eq(TaskCommandTable.status, "accepted")))
      .returning()
      .get()
    if (row) return Command.parse(row)
    const current = tx.select().from(TaskCommandTable).where(eq(TaskCommandTable.id, id)).limit(1).get()
    if (!current) throw new Conflict("task_command_missing")
    if (current.status !== "applied") throw new Conflict("task_command_invalid_state")
    if (current.result_ref !== (result ?? null)) throw new Conflict("task_command_result_drift")
    return Command.parse(current)
  }

  export function append(tx: Database.Transaction, taskID: string, events: z.input<typeof NewEvent>[]) {
    const id = TaskID.parse(taskID)
    const input = z.array(NewEvent).min(1).parse(events)
    const task = tx
      .select({ seq: SessionTaskTable.last_event_seq })
      .from(SessionTaskTable)
      .where(eq(SessionTaskTable.id, id))
      .limit(1)
      .get()
    if (!task) throw new Conflict("task_event_task_missing")
    const end = task.seq + input.length
    if (!Number.isSafeInteger(task.seq) || task.seq < 0 || !Number.isSafeInteger(end))
      throw new Conflict("task_event_seq_invalid")
    const saved = tx
      .update(SessionTaskTable)
      .set({ last_event_seq: end, time_updated: Date.now() })
      .where(and(eq(SessionTaskTable.id, id), eq(SessionTaskTable.last_event_seq, task.seq)))
      .returning({ seq: SessionTaskTable.last_event_seq })
      .get()
    if (saved?.seq !== end) throw new Conflict("task_event_seq_conflict")
    const time = Date.now()
    return tx
      .insert(TaskEventTable)
      .values(
        input.map((item, index) => ({
          task_id: id,
          seq: task.seq + index + 1,
          id: `event_${randomUUID()}`,
          type: item.type,
          revision_id: item.revision_id,
          command_id: item.command_id,
          data: item.data,
          resource_refs: item.resource_refs,
          time_created: time,
        })),
      )
      .returning()
      .all()
      .map((row) => Event.parse(row))
      .sort((a, b) => a.seq - b.seq)
  }

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
