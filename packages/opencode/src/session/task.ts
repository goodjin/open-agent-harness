import { randomUUID } from "crypto"
import z from "zod"
import { and, Database, desc, eq, max } from "@/storage/db"
import { MessageID, SessionID } from "./schema"
import { SessionTaskTable, TaskRevisionTable } from "./session.sql"

export namespace SessionTask {
  export const Status = z.enum(["running", "waiting_user", "revising", "blocked", "completed", "failed"])
  export type Status = z.infer<typeof Status>
  export const SourceType = z.enum(["user", "delegation", "handoff", "legacy"])
  export type SourceType = z.infer<typeof SourceType>
  export const Source = z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), messageID: MessageID.zod.optional() }).strict(),
    z
      .object({
        type: z.literal("delegation"),
        sessionID: SessionID.zod,
        messageID: MessageID.zod.optional(),
        actionID: z.string().min(1).optional(),
      })
      .strict(),
    z.object({ type: z.literal("handoff"), handoffID: z.string().min(1) }).strict(),
    z.object({ type: z.literal("legacy"), runID: z.string().min(1).optional() }).strict(),
  ])
  export type Source = z.infer<typeof Source>
  export const RevisionStatus = z.enum(["draft", "active", "completed", "failed", "archived"])
  export type RevisionStatus = z.infer<typeof RevisionStatus>
  export const Workflow = z.object({ actions: z.array(z.unknown()) }).strict()
  export type Workflow = z.infer<typeof Workflow>
  export const Task = z
    .object({
      id: z.string().min(1),
      session_id: SessionID.zod,
      title: z.string().min(1),
      status: Status,
      current_revision_id: z.string().nullable(),
      source_type: SourceType,
      source_ref: z.record(z.string(), z.unknown()),
      time_created: z.number().int().nonnegative(),
      time_updated: z.number().int().nonnegative(),
    })
    .strict()
  export type Task = z.infer<typeof Task>
  export const Revision = z
    .object({
      id: z.string().min(1),
      task_id: z.string().min(1),
      version: z.number().int().positive(),
      previous_id: z.string().nullable(),
      status: RevisionStatus,
      title: z.string().min(1),
      body: z.string(),
      body_hash: z.string().length(64),
      source_message_id: MessageID.zod.nullable(),
      reason: z.string().nullable(),
      workflow: Workflow,
      result: z.string().nullable(),
      result_source: z.string().nullable(),
      time_created: z.number().int().nonnegative(),
      time_activated: z.number().int().nonnegative().nullable(),
      time_completed: z.number().int().nonnegative().nullable(),
      time_archived: z.number().int().nonnegative().nullable(),
      archive_reason: z.string().nullable(),
    })
    .strict()
  export type Revision = z.infer<typeof Revision>
  export const View = z.object({ task: Task, revision: Revision }).strict()
  export type View = z.infer<typeof View>
  export const History = Revision
  export type History = z.infer<typeof History>

  const Create = z
    .object({
      sessionID: SessionID.zod,
      title: z.string().trim().min(1),
      body: z.string(),
      source: Source,
    })
    .strict()
  const Draft = z
    .object({
      taskID: z.string().min(1),
      title: z.string().trim().min(1),
      body: z.string(),
      reason: z.string().trim().min(1).optional(),
      messageID: MessageID.zod.optional(),
    })
    .strict()
  const Activate = z.object({ taskID: z.string().min(1), revisionID: z.string().min(1) }).strict()

  export class Conflict extends Error {
    constructor(message = "session_task_conflict") {
      super(message)
      this.name = "SessionTaskConflict"
    }
  }

  export async function create(raw: z.input<typeof Create>) {
    const input = Create.parse(raw)
    const now = Date.now()
    const task = `task_${randomUUID()}`
    const revision = `revision_${randomUUID()}`
    const source = { ...input.source } as Record<string, unknown>
    delete source.type

    try {
      return Database.transaction(
        (tx) => {
          const found = tx
            .select({ id: SessionTaskTable.id })
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.session_id, input.sessionID))
            .get()
          if (found) throw new Conflict()
          tx.insert(SessionTaskTable)
            .values({
              id: task,
              session_id: input.sessionID,
              title: input.title,
              status: "running",
              current_revision_id: null,
              source_type: input.source.type,
              source_ref: source,
              time_created: now,
              time_updated: now,
            })
            .run()
          tx.insert(TaskRevisionTable)
            .values({
              id: revision,
              task_id: task,
              version: 1,
              previous_id: null,
              status: "active",
              title: input.title,
              body: input.body,
              body_hash: hash(input.body),
              source_message_id: "messageID" in input.source ? (input.source.messageID ?? null) : null,
              reason: null,
              workflow: { actions: [] },
              result: null,
              result_source: null,
              time_created: now,
              time_activated: now,
              time_completed: null,
              time_archived: null,
              archive_reason: null,
            })
            .run()
          const saved = tx
            .update(SessionTaskTable)
            .set({ current_revision_id: revision })
            .where(eq(SessionTaskTable.id, task))
            .returning()
            .get()
          const current = tx.select().from(TaskRevisionTable).where(eq(TaskRevisionTable.id, revision)).get()
          return View.parse({ task: saved, revision: current })
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (unique(err) || locked(err)) throw new Conflict()
      throw err
    }
  }

  export async function get(sessionID: SessionID) {
    const task = Database.use((tx) =>
      tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, sessionID)).get(),
    )
    if (!task) return
    const revision = Database.use((tx) =>
      tx
        .select()
        .from(TaskRevisionTable)
        .where(eq(TaskRevisionTable.id, task.current_revision_id ?? ""))
        .get(),
    )
    if (!revision) throw new Conflict("session_task_revision_missing")
    return View.parse({ task, revision })
  }

  export async function draft(raw: z.input<typeof Draft>) {
    const input = Draft.parse(raw)
    const now = Date.now()
    try {
      return Database.transaction(
        (tx) => {
          const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.id, input.taskID)).get()
          if (!task) throw new Conflict("session_task_missing")
          const version =
            (tx
              .select({ value: max(TaskRevisionTable.version) })
              .from(TaskRevisionTable)
              .where(eq(TaskRevisionTable.task_id, input.taskID))
              .get()?.value ?? 0) + 1
          const row = tx
            .insert(TaskRevisionTable)
            .values({
              id: `revision_${randomUUID()}`,
              task_id: input.taskID,
              version,
              previous_id: task.current_revision_id,
              status: "draft",
              title: input.title,
              body: input.body,
              body_hash: hash(input.body),
              source_message_id: input.messageID ?? null,
              reason: input.reason ?? null,
              workflow: { actions: [] },
              result: null,
              result_source: null,
              time_created: now,
              time_activated: null,
              time_completed: null,
              time_archived: null,
              archive_reason: null,
            })
            .returning()
            .get()
          return Revision.parse(row)
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (unique(err) || locked(err)) throw new Conflict("task_revision_conflict")
      throw err
    }
  }

  export async function activate(raw: z.input<typeof Activate>) {
    const input = Activate.parse(raw)
    const now = Date.now()
    try {
      return Database.transaction(
        (tx) => {
          const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.id, input.taskID)).get()
          const next = tx.select().from(TaskRevisionTable).where(eq(TaskRevisionTable.id, input.revisionID)).get()
          if (
            !task?.current_revision_id ||
            !next ||
            next.task_id !== input.taskID ||
            next.status !== "draft" ||
            next.previous_id !== task.current_revision_id
          )
            throw new Conflict()
          const archived = tx
            .update(TaskRevisionTable)
            .set({ status: "archived", time_archived: now, archive_reason: next.reason ?? "Task revised" })
            .where(
              and(
                eq(TaskRevisionTable.id, task.current_revision_id),
                eq(TaskRevisionTable.task_id, input.taskID),
                eq(TaskRevisionTable.status, "active"),
              ),
            )
            .returning({ id: TaskRevisionTable.id })
            .get()
          if (!archived) throw new Conflict()
          const revision = tx
            .update(TaskRevisionTable)
            .set({ status: "active", time_activated: now })
            .where(
              and(
                eq(TaskRevisionTable.id, next.id),
                eq(TaskRevisionTable.task_id, input.taskID),
                eq(TaskRevisionTable.status, "draft"),
              ),
            )
            .returning()
            .get()
          if (!revision) throw new Conflict()
          const updated = tx
            .update(SessionTaskTable)
            .set({ title: next.title, current_revision_id: next.id, status: "running", time_updated: now })
            .where(
              and(
                eq(SessionTaskTable.id, input.taskID),
                eq(SessionTaskTable.current_revision_id, task.current_revision_id),
              ),
            )
            .returning({ id: SessionTaskTable.id })
            .get()
          if (!updated) throw new Conflict()
          return Revision.parse(revision)
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (unique(err) || locked(err)) throw new Conflict("task_revision_active_conflict")
      throw err
    }
  }

  export async function history(sessionID: SessionID) {
    const task = Database.use((tx) =>
      tx
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, sessionID))
        .get(),
    )
    if (!task) return []
    return Database.use((tx) =>
      tx
        .select()
        .from(TaskRevisionTable)
        .where(and(eq(TaskRevisionTable.task_id, task.id), eq(TaskRevisionTable.status, "archived")))
        .orderBy(desc(TaskRevisionTable.version))
        .all()
        .map((item) => History.parse(item)),
    )
  }

  function hash(input: string) {
    return new Bun.CryptoHasher("sha256").update(input).digest("hex")
  }

  function unique(err: unknown) {
    return err instanceof Error && err.message.includes("UNIQUE constraint failed")
  }

  function locked(err: unknown) {
    if (!(err instanceof Error)) return false
    const code = "code" in err && typeof err.code === "string" ? err.code : ""
    return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || err.message.includes("database is locked")
  }
}
