import { randomUUID } from "crypto"
import { SQLiteError } from "bun:sqlite"
import z from "zod"
import { AgentProtocol } from "@/protocol/schema"
import { and, Database, desc, eq, max } from "@/storage/db"
import { MessageID, SessionID } from "./schema"
import { SessionTable, SessionTaskTable, TaskRevisionTable } from "./session.sql"
import type { SessionRuns } from "./runs"
import { TaskDocuments } from "./task-documents"

export namespace SessionTask {
  export const Status = z.enum(["running", "waiting_user", "revising", "blocked", "completed", "failed"])
  export type Status = z.infer<typeof Status>
  export const RunID = z.string().regex(/^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/)
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
        runID: RunID.optional(),
      })
      .strict(),
    z.object({ type: z.literal("handoff"), handoffID: z.string().min(1) }).strict(),
    z.object({ type: z.literal("legacy"), runID: z.string().min(1).optional() }).strict(),
  ])
  export type Source = z.infer<typeof Source>
  export const RevisionStatus = z.enum(["draft", "active", "completed", "failed", "archived"])
  export type RevisionStatus = z.infer<typeof RevisionStatus>
  export const Workflow = z
    .object({
      actions: z.array(z.unknown()),
      run_id: RunID.optional(),
    })
    .strict()
  export type Workflow = z.infer<typeof Workflow>
  export const WorkflowView = z
    .object({
      actions: z.array(AgentProtocol.ResultAction),
      run_id: RunID.optional(),
    })
    .strict()
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
  export const Stored = z.object({ task: Task, revision: Revision }).strict()
  export type Stored = z.infer<typeof Stored>
  export const ResultSource = z.enum(["protocol", "action_result", "fallback_summary"])
  export type ResultSource = z.infer<typeof ResultSource>
  export const HandoffSummary = z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      status: z.enum(["proposed", "confirmed", "creating", "started", "failed", "cancelled"]),
      target_session_id: SessionID.zod.optional(),
    })
    .strict()
  export const View = z
    .object({
      id: z.string().min(1),
      session_id: SessionID.zod,
      title: z.string().min(1),
      version: z.number().int().positive(),
      status: Status,
      body: z.string(),
      progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
      actions: z.array(AgentProtocol.ResultAction),
      result: z.string().optional(),
      result_source: ResultSource.optional(),
      handoffs: z.array(HandoffSummary),
      time: z
        .object({
          created: z.number().int().nonnegative(),
          updated: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict()
  export type View = z.infer<typeof View>
  export const LegacyView = View.extend({ type: z.literal("legacy_task") }).strict()
  export type LegacyView = z.infer<typeof LegacyView>
  export const History = z
    .object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      status: z.literal("archived"),
      title: z.string().min(1),
      reason: z.string().nullable(),
      archive_reason: z.string().nullable(),
      time: z
        .object({ created: z.number().int().nonnegative(), archived: z.number().int().nonnegative().optional() })
        .strict(),
    })
    .strict()
  export type History = z.infer<typeof History>
  export const RevisionView = z
    .object({
      id: z.string().min(1),
      session_id: SessionID.zod,
      title: z.string().min(1),
      version: z.number().int().positive(),
      status: RevisionStatus,
      body: z.string(),
      workflow: WorkflowView,
      actions: z.array(AgentProtocol.ResultAction),
      result: z.string().optional(),
      result_source: ResultSource.optional(),
      time: z
        .object({
          created: z.number().int().nonnegative(),
          activated: z.number().int().nonnegative().optional(),
          completed: z.number().int().nonnegative().optional(),
          archived: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict()
  export type RevisionView = z.infer<typeof RevisionView>

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
          const result = Stored.parse({ task: saved, revision: current })
          Database.effect(() =>
            TaskDocuments.publish({
              sessionID: result.task.session_id,
              taskID: result.task.id,
              version: result.revision.version,
              title: result.revision.title,
              body: result.revision.body,
              current: true,
            }),
          )
          return result
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (constraint(err) || locked(err)) throw new Conflict()
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
    return Stored.parse({ task, revision })
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
          const result = Revision.parse(row)
          Database.effect(() =>
            TaskDocuments.publish({
              sessionID: task.session_id,
              taskID: task.id,
              version: result.version,
              title: result.title,
              body: result.body,
              current: false,
            }),
          )
          return result
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (constraint(err) || locked(err)) throw new Conflict("task_revision_conflict")
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
          const result = Revision.parse(revision)
          Database.effect(() =>
            TaskDocuments.publish({
              sessionID: task.session_id,
              taskID: task.id,
              version: result.version,
              title: result.title,
              body: result.body,
              current: true,
            }),
          )
          return result
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (constraint(err) || locked(err)) throw new Conflict("task_revision_active_conflict")
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
        .select({
          id: TaskRevisionTable.id,
          version: TaskRevisionTable.version,
          status: TaskRevisionTable.status,
          title: TaskRevisionTable.title,
          reason: TaskRevisionTable.reason,
          archive_reason: TaskRevisionTable.archive_reason,
          time_created: TaskRevisionTable.time_created,
          time_archived: TaskRevisionTable.time_archived,
        })
        .from(TaskRevisionTable)
        .where(and(eq(TaskRevisionTable.task_id, task.id), eq(TaskRevisionTable.status, "archived")))
        .orderBy(desc(TaskRevisionTable.version))
        .all()
        .map((item) =>
          History.parse({
            id: item.id,
            version: item.version,
            status: item.status,
            title: item.title,
            reason: item.reason,
            archive_reason: item.archive_reason,
            time: {
              created: item.time_created,
              ...(item.time_archived === null ? {} : { archived: item.time_archived }),
            },
          }),
        ),
    )
  }

  export async function current(sessionID: SessionID) {
    const stored = await get(sessionID)
    if (!stored) return
    const { SessionRuns } = await import("./runs")
    const run = stored.revision.workflow.run_id
      ? await SessionRuns.get(sessionID, stored.revision.workflow.run_id)
      : undefined
    const trusted = valid(stored.task, run)
    const actions = trusted?.actions ?? workflow(stored.revision.workflow)
    const output = trusted?.summary ? result(trusted.summary, trusted.summary_source) : {}
    return View.parse({
      id: stored.task.id,
      session_id: stored.task.session_id,
      title: stored.revision.title,
      version: stored.revision.version,
      status: stored.task.status,
      body: stored.revision.body,
      progress: {
        completed: actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
        total: actions.length,
      },
      actions,
      ...output,
      handoffs: [],
      time: {
        created: stored.task.time_created,
        updated: stored.task.time_updated,
        ...(stored.revision.time_completed === null ? {} : { completed: stored.revision.time_completed }),
      },
    })
  }

  export async function revision(sessionID: SessionID, version: number) {
    const parsed = z.number().int().positive().safeParse(version)
    if (!parsed.success) return
    const row = Database.use((db) =>
      db
        .select({ task: SessionTaskTable, revision: TaskRevisionTable })
        .from(TaskRevisionTable)
        .innerJoin(SessionTaskTable, eq(SessionTaskTable.id, TaskRevisionTable.task_id))
        .where(and(eq(SessionTaskTable.session_id, sessionID), eq(TaskRevisionTable.version, parsed.data)))
        .get(),
    )
    if (!row) return
    const item = Revision.parse(row.revision)
    const saved = result(item.result, item.result_source)
    return RevisionView.parse({
      id: item.id,
      session_id: row.task.session_id,
      title: item.title,
      version: item.version,
      status: item.status,
      body: item.body,
      workflow: { ...item.workflow, actions: workflow(item.workflow) },
      actions: workflow(item.workflow),
      ...saved,
      time: {
        created: item.time_created,
        ...(item.time_activated === null ? {} : { activated: item.time_activated }),
        ...(item.time_completed === null ? {} : { completed: item.time_completed }),
        ...(item.time_archived === null ? {} : { archived: item.time_archived }),
      },
    })
  }

  export async function legacy(sessionID: SessionID) {
    const { SessionRuns } = await import("./runs")
    const runs = await SessionRuns.list(sessionID)
    if (!runs.length) return
    if (runs.length > 1) return { type: "legacy_multi_run" as const, count: runs.length }
    const run = runs[0]!
    return LegacyView.parse({
      type: "legacy_task",
      id: run.run_id,
      session_id: sessionID,
      title: run.title ?? "Legacy task",
      version: 1,
      status: run.status,
      body: run.task,
      progress: {
        completed: run.actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
        total: run.actions.length,
      },
      actions: run.actions,
      ...(run.summary && run.summary_source ? { result: run.summary, result_source: run.summary_source } : {}),
      handoffs: [],
      time: {
        created: run.time.started,
        updated: run.time.completed ?? run.time.started,
        ...(run.time.completed === undefined ? {} : { completed: run.time.completed }),
      },
    })
  }

  function valid(task: Task, run: SessionRuns.Run | undefined) {
    if (!run) return
    if (task.source_type !== "delegation") return run.kind === "protocol" ? run : undefined
    const source = task.source_ref
    const parent = typeof source.sessionID === "string" ? source.sessionID : undefined
    const action = typeof source.actionID === "string" ? source.actionID : undefined
    const sourceRun = typeof source.runID === "string" ? source.runID : undefined
    if (!parent || !action || sourceRun !== run.run_id || run.kind !== "delegation" || run.action_id !== action) return
    const session = Database.use((db) =>
      db
        .select({ parent_id: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, task.session_id))
        .get(),
    )
    if (session?.parent_id !== parent) return
    if (run.summary_source !== "action_result" && run.summary_source !== "fallback_summary")
      return { ...run, summary: undefined, summary_source: undefined }
    return run
  }

  function result(value: string | null | undefined, source: string | null | undefined) {
    const body = typeof value === "string" && value.trim() ? value.trim() : undefined
    const parsed = ResultSource.safeParse(source)
    if (!body || !parsed.success) return {}
    return { result: body, result_source: parsed.data }
  }

  function workflow(value: Workflow) {
    return value.actions.flatMap((item) => {
      const parsed = AgentProtocol.ResultAction.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  }

  function hash(input: string) {
    return new Bun.CryptoHasher("sha256").update(input).digest("hex")
  }

  function constraint(err: unknown) {
    return err instanceof SQLiteError && typeof err.code === "string" && err.code.startsWith("SQLITE_CONSTRAINT")
  }

  function locked(err: unknown) {
    if (!(err instanceof SQLiteError)) return false
    if (typeof err.code !== "string") return false
    return err.code.startsWith("SQLITE_BUSY") || err.code.startsWith("SQLITE_LOCKED")
  }
}
