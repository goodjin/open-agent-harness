import { randomUUID } from "crypto"
import { SQLiteError } from "bun:sqlite"
import z from "zod"
import { AgentProtocol } from "@/protocol/schema"
import { and, Database, desc, eq, gt, inArray, max, notExists } from "@/storage/db"
import { MessageID, SessionID } from "./schema"
import {
  AssignmentTable,
  SessionEventOutboxTable,
  SessionResultTable,
  SessionTable,
  SessionTaskTable,
  TaskRevisionTable,
} from "./session.sql"
import type { SessionRuns } from "./runs"
import { TaskDocuments } from "./task-documents"
import { SessionAssignment } from "./assignment"
import { SessionStatus } from "./status"
import { SessionResult } from "./result"

export function locators(rows: { run: string; action: string; child: SessionID }[]) {
  const groups = Map.groupBy(rows, (item) => `${item.run}:${item.action}`)
  return {
    ambiguous: [...groups.values()].some((items) => items.length !== 1),
    values: new Map(
      [...groups].flatMap(([key, items]) => (items.length === 1 ? [[key, items[0]!.child] as const] : [])),
    ),
  }
}

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
    z
      .object({ type: z.literal("handoff"), handoffID: z.string().min(1), sourceSessionID: SessionID.zod.optional() })
      .strict(),
    z.object({ type: z.literal("legacy"), runID: z.string().min(1).optional() }).strict(),
  ])
  export type Source = z.infer<typeof Source>
  export const RevisionStatus = z.enum(["draft", "active", "completed", "failed", "archived"])
  export type RevisionStatus = z.infer<typeof RevisionStatus>
  export const TerminalStatus = z.enum(["completed", "blocked", "failed"])
  export const ArchiveResult = z.enum(["completed", "partial", "failed"])
  export const Workflow = z
    .object({
      actions: z.array(z.unknown()),
      assignment_id: z.string().min(1).optional(),
      run_id: RunID.optional(),
      run_ids: z.array(RunID).optional(),
      compact: z
        .object({
          runs: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict()
  export type Workflow = z.infer<typeof Workflow>
  export const TaskAction = AgentProtocol.ResultAction.extend({ run_id: RunID }).strict()
  export type TaskAction = z.infer<typeof TaskAction>
  export const WorkflowView = z
    .object({
      actions: z.array(TaskAction),
      assignment_id: Workflow.shape.assignment_id,
      run_id: RunID.optional(),
      run_ids: z.array(RunID).optional(),
      compact: Workflow.shape.compact,
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
      terminal_status: TerminalStatus.nullable(),
      stopped_child_count: z.number().int().nonnegative().nullable(),
      result_status: ArchiveResult.nullable(),
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
      target_task_id: z.string().min(1).optional(),
      source_session_id: SessionID.zod,
      source_task_id: z.string().min(1).optional(),
      error: z.string().optional(),
      time: z
        .object({
          created: z.number().int().nonnegative(),
          confirmed: z.number().int().nonnegative().optional(),
          completed: z.number().int().nonnegative().optional(),
        })
        .strict(),
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
      actions: z.array(TaskAction),
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
  export const Summary = z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      version: z.number().int().positive(),
      status: Status,
      completed_actions: z.number().int().nonnegative(),
      total_actions: z.number().int().nonnegative(),
    })
    .strict()
    .meta({ ref: "SessionTaskSummary" })
  export type Summary = z.infer<typeof Summary>
  export const LegacyView = View.extend({ type: z.literal("legacy_task") }).strict()
  export type LegacyView = z.infer<typeof LegacyView>
  export const LegacyMigration = z
    .object({
      type: z.literal("legacy_multi_run"),
      count: z.number().int().min(2),
      proposal: z
        .object({
          status: z.literal("pending_confirmation"),
          session_id: SessionID.zod,
          runs: z.array(
            z
              .object({
                run_id: RunID,
                title: z.string().min(1),
                status: z.enum(["running", "completed", "blocked", "failed"]),
                result: z.string().optional(),
                result_source: ResultSource.optional(),
                time: z
                  .object({
                    started: z.number().int().nonnegative(),
                    completed: z.number().int().nonnegative().optional(),
                  })
                  .strict(),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict()
    .meta({ ref: "SessionTaskLegacyMigration" })
  export type LegacyMigration = z.infer<typeof LegacyMigration>
  export const Current = z.union([View, LegacyMigration]).meta({ ref: "SessionTaskCurrent" })
  export const History = z
    .object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      status: z.literal("archived"),
      title: z.string().min(1),
      reason: z.string().nullable(),
      archive_reason: z.string().nullable(),
      terminal_status: TerminalStatus.optional(),
      stopped_child_count: z.number().int().nonnegative().optional(),
      result: z.object({ present: z.boolean(), status: ArchiveResult.optional() }).strict(),
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
      actions: z.array(TaskAction),
      result: z.string().optional(),
      result_source: ResultSource.optional(),
      result_status: ArchiveResult.optional(),
      terminal_status: TerminalStatus.optional(),
      stopped_child_count: z.number().int().nonnegative().optional(),
      reason: z.string().nullable(),
      archive_reason: z.string().nullable(),
      handoffs: z.array(HandoffSummary),
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
  const Activate = z
    .object({
      taskID: z.string().min(1),
      revisionID: z.string().min(1),
      bootstrap: z.boolean().optional(),
      stopped: z.number().int().nonnegative().optional().default(0),
    })
    .strict()
  const Route = z
    .object({
      sessionID: SessionID.zod,
      runID: RunID.optional(),
      messageID: MessageID.zod.optional(),
      assignment: z
        .object({
          op: z.enum(["create", "update", "handoff"]),
          target: z.enum(["self", "peer"]),
          title: z.string().trim().min(1),
          body: z.string(),
        })
        .strict()
        .optional(),
      actions: z.array(z.unknown()),
      legacy: z
        .object({ title: z.string().trim().min(1), body: z.string() })
        .strict()
        .optional(),
      source: Source.optional(),
    })
    .strict()
  const Finish = z
    .object({
      sessionID: SessionID.zod,
      runID: RunID,
      summary: z.string().trim().min(1),
      source: ResultSource,
    })
    .strict()

  export class Conflict extends Error {
    constructor(message = "session_task_conflict") {
      super(message)
      this.name = "SessionTaskConflict"
    }
  }

  export async function preflight(sessionID: SessionID, actions: unknown[]) {
    const assignments = actions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      const action = item as { executor?: { type?: unknown }; operation?: unknown; input?: unknown }
      if (action.executor?.type !== "human" || action.operation !== "confirm") return []
      const input = action.input && typeof action.input === "object" && !Array.isArray(action.input) ? action.input : {}
      const value = "assignment" in input ? input.assignment : undefined
      if (!value || typeof value !== "object" || Array.isArray(value)) return []
      const meta = value as { op?: unknown; target?: unknown }
      if (meta.op !== "create" && meta.op !== "update" && meta.op !== "handoff") return []
      return [{ op: meta.op, target: meta.target }]
    })
    if (assignments.length > 1) throw new Conflict("session_task_assignment_ambiguous")
    const assignment = assignments[0]
    if (!assignment) return
    const current = await get(sessionID)
    if (current && assignment.op === "create") throw new Conflict()
    if (!current && assignment.op === "update") throw new Conflict("session_task_update_requires_bound_source")
    if (!current && assignment.op === "handoff") throw new Conflict("task_handoff_requires_bound_source")
  }

  export async function confirmed(input: {
    sessionID: SessionID
    runID: string
    actionIDs: string[]
    messageID?: MessageID
    actions: unknown[]
    legacy: { title: string; body: string }
    requiresAssignment?: boolean
  }) {
    const rows = await Promise.all(
      input.actionIDs.map((actionID) =>
        SessionAssignment.bySource({ sessionID: input.sessionID, runID: input.runID, actionID }),
      ),
    )
    const sourced = rows.findLast((item) => item !== undefined)
    const inherited =
      sourced || input.requiresAssignment ? undefined : await SessionAssignment.unique(input.sessionID, "confirm")
    if (inherited === null) throw new Conflict("session_task_assignment_source_conflict")
    const assignment = sourced ?? inherited
    if (!assignment && input.requiresAssignment) throw new Conflict("session_task_assignment_source_conflict")
    if (!assignment)
      return route({
        sessionID: input.sessionID,
        runID: input.runID,
        messageID: input.messageID,
        legacy: input.legacy,
        actions: input.actions,
      })
    if (assignment.source_type !== "confirm") throw new Conflict("session_task_assignment_not_current")
    if (assignment.session_id !== input.sessionID || assignment.source_session_id !== input.sessionID)
      throw new Conflict("session_task_assignment_source_conflict")
    if (
      sourced &&
      (assignment.source_run_id !== input.runID || !input.actionIDs.includes(assignment.source_action_id ?? ""))
    )
      throw new Conflict("session_task_assignment_source_conflict")
    const sourceRun = assignment.source_run_id
    const sourceAction = assignment.source_action_id
    if (!sourceRun || !sourceAction) throw new Conflict("session_task_assignment_source_conflict")
    const content = await SessionAssignment.content(assignment.id)
    const body = content && typeof content === "object" && !Array.isArray(content) ? content : {}
    const legacy = assignment.content_ref.split("/").at(-1)?.startsWith("rev-") === true
    const meta =
      !legacy && "assignment" in body && body.assignment && typeof body.assignment === "object" ? body.assignment : {}
    const fallback = legacy && !(await get(input.sessionID)) ? { op: "create", target: "self" } : undefined
    const op = "op" in meta ? meta.op : fallback?.op
    const target = "target" in meta ? meta.target : (fallback?.target ?? assignment.target)
    if (op !== "create" && op !== "update" && op !== "handoff")
      throw new Conflict("session_task_assignment_content_invalid")
    if (target !== "self" && target !== "peer") throw new Conflict("session_task_assignment_content_invalid")
    const plan = "plan" in body ? body.plan : undefined
    if (typeof plan !== "string") throw new Conflict("session_task_assignment_content_invalid")
    if (assignment.status === "completed") {
      if (!sourced) throw new Conflict("session_task_assignment_not_current")
      if (op === "handoff") {
        const task = await get(input.sessionID)
        if (!task) throw new Conflict("task_handoff_requires_bound_source")
        return { type: "handoff" as const, task: task.task }
      }
      return replay({ assignment, op, plan, sessionID: input.sessionID })
    }
    const active = await SessionAssignment.active(input.sessionID)
    if (active?.id !== assignment.id || assignment.status !== "running")
      throw new Conflict("session_task_assignment_not_current")
    if (!sourced && op === "handoff") throw new Conflict("session_task_handoff_pending")
    return transact(
      (tx) => {
        const locator = {
          assignment,
          sessionID: input.sessionID,
          sourceSessionID: input.sessionID,
          runID: sourceRun,
          actionIDs: [sourceAction],
          source: "confirm" as const,
        }
        if (!SessionAssignment.withCurrent(tx, locator)) throw new Conflict("session_task_assignment_not_current")
        const saved = write(
          {
            sessionID: input.sessionID,
            runID: input.runID,
            messageID: input.messageID,
            assignment: { op, target, title: assignment.title, body: plan },
            actions: input.actions,
          },
          assignment.id,
        )
        if (!SessionAssignment.withCurrent(tx, locator)) throw new Conflict("session_task_assignment_not_current")
        if (op !== "handoff" && !SessionAssignment.consume(tx, locator))
          throw new Conflict("session_task_assignment_not_current")
        return saved
      },
      { behavior: "immediate" },
    )
  }

  function replay(input: {
    assignment: SessionAssignment.Info
    op: "create" | "update"
    plan: string
    sessionID: SessionID
  }) {
    return transact(
      (tx) => {
        if (!SessionAssignment.withStatus(tx, input.assignment, "completed"))
          throw new Conflict("session_task_assignment_not_current")
        const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, input.sessionID)).get()
        if (!task) throw new Conflict("session_task_assignment_not_current")
        const revisions = tx
          .select()
          .from(TaskRevisionTable)
          .where(
            and(
              eq(TaskRevisionTable.task_id, task.id),
              eq(TaskRevisionTable.title, input.assignment.title),
              eq(TaskRevisionTable.body_hash, hash(input.plan)),
            ),
          )
          .orderBy(desc(TaskRevisionTable.version))
          .all()
        const revision = bound(
          revisions,
          input.assignment,
          input.assignment.content_ref.split("/").at(-1)?.startsWith("rev-") === true,
        )
        if (
          !revision ||
          (input.op === "create" && revision.previous_id !== null) ||
          (input.op === "update" && revision.previous_id === null)
        )
          throw new Conflict("session_task_assignment_not_current")
        return { type: "replay" as const, task: Task.parse(task), revision: Revision.parse(revision) }
      },
      { behavior: "immediate" },
    )
  }

  export async function route(raw: z.input<typeof Route>) {
    return write(raw)
  }

  function write(raw: z.input<typeof Route>, assignmentID?: string) {
    const input = Route.parse(raw)
    const now = Date.now()
    try {
      return transact(
        (tx) => {
          const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, input.sessionID)).get()
          if (!task) {
            if (input.assignment?.op === "handoff") throw new Conflict("task_handoff_requires_bound_source")
            if (input.assignment?.op === "update") throw new Conflict("session_task_update_requires_bound_source")
            const seed = input.assignment ?? input.legacy
            if (!seed) throw new Conflict("session_task_assignment_required")
            const id = `task_${randomUUID()}`
            const revision = `revision_${randomUUID()}`
            const source = input.source ?? { type: "user" as const, messageID: input.messageID }
            if (!input.runID && source.type !== "delegation") throw new Conflict("session_task_run_required")
            const ref = { ...source } as Record<string, unknown>
            delete ref.type
            tx.insert(SessionTaskTable)
              .values({
                id,
                session_id: input.sessionID,
                title: seed.title,
                status: "running",
                current_revision_id: null,
                source_type: source.type,
                source_ref: ref,
                time_created: now,
                time_updated: now,
              })
              .run()
            tx.insert(TaskRevisionTable)
              .values({
                id: revision,
                task_id: id,
                version: 1,
                previous_id: null,
                status: "active",
                title: seed.title,
                body: seed.body,
                body_hash: hash(seed.body),
                source_message_id: input.messageID ?? null,
                reason: null,
                workflow: flow(input.actions, input.runID, assignmentID),
                result: null,
                result_source: null,
                time_created: now,
                time_activated: now,
                time_completed: null,
                time_archived: null,
                archive_reason: null,
                terminal_status: null,
                stopped_child_count: null,
                result_status: null,
              })
              .run()
            tx.update(SessionTaskTable).set({ current_revision_id: revision }).where(eq(SessionTaskTable.id, id)).run()
            const stored = Stored.parse({
              task: tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.id, id)).get(),
              revision: tx.select().from(TaskRevisionTable).where(eq(TaskRevisionTable.id, revision)).get(),
            })
            Database.effect(() =>
              TaskDocuments.publish({
                sessionID: input.sessionID,
                taskID: id,
                version: 1,
                title: seed.title,
                body: seed.body,
                current: true,
              }),
            )
            return { type: "execute" as const, ...stored }
          }
          if (!task.current_revision_id) throw new Conflict("session_task_revision_missing")
          const current = tx
            .select()
            .from(TaskRevisionTable)
            .where(eq(TaskRevisionTable.id, task.current_revision_id))
            .get()
          if (!current || current.task_id !== task.id) throw new Conflict("session_task_revision_missing")
          if (input.assignment?.op === "create") throw new Conflict()
          if (input.assignment?.op === "handoff") return { type: "handoff" as const, task: Task.parse(task) }
          if (input.assignment?.op === "update") {
            if (task.status === "revising" || task.status === "blocked")
              throw new Conflict("session_task_update_in_progress")
            if (current.status !== "active") throw new Conflict("session_task_revision_not_active")
            if (!input.runID) throw new Conflict("session_task_run_required")
            const version =
              (tx
                .select({ value: max(TaskRevisionTable.version) })
                .from(TaskRevisionTable)
                .where(eq(TaskRevisionTable.task_id, task.id))
                .get()?.value ?? current.version) + 1
            const revision = tx
              .insert(TaskRevisionTable)
              .values({
                id: `revision_${randomUUID()}`,
                task_id: task.id,
                version,
                previous_id: current.id,
                status: "draft",
                title: input.assignment.title,
                body: input.assignment.body,
                body_hash: hash(input.assignment.body),
                source_message_id: input.messageID ?? null,
                reason: "Confirmed task update proposal",
                workflow: flow(input.actions, input.runID, assignmentID),
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
            const frozen = tx
              .update(SessionTaskTable)
              .set({ status: "revising", time_updated: now })
              .where(
                and(
                  eq(SessionTaskTable.id, task.id),
                  eq(SessionTaskTable.current_revision_id, current.id),
                  inArray(SessionTaskTable.status, ["running", "waiting_user"]),
                ),
              )
              .returning()
              .get()
            if (!frozen) throw new Conflict("session_task_revision_frozen")
            return { type: "update" as const, task: Task.parse(frozen), revision: Revision.parse(revision) }
          }
          if ((task.status === "revising" || task.status === "blocked") && orchestration(input.actions))
            return { type: "execute" as const, task: Task.parse(task), revision: Revision.parse(current) }
          if (task.status === "revising" || task.status === "blocked")
            throw new Conflict("session_task_revision_frozen")
          if (current.status !== "active") throw new Conflict("session_task_revision_not_active")
          if (!input.runID)
            return { type: "execute" as const, task: Task.parse(task), revision: Revision.parse(current) }
          const actions = merge(
            Array.isArray(current.workflow.actions) ? current.workflow.actions : [],
            tagged(input.actions, input.runID),
          )
          const ids = runids(Workflow.parse(current.workflow))
          const run_ids = ids.includes(input.runID) ? ids : [...ids, input.runID]
          const revision = tx
            .update(TaskRevisionTable)
            .set({ workflow: bounded({ ...Workflow.parse(current.workflow), actions, run_id: input.runID, run_ids }) })
            .where(
              and(
                eq(TaskRevisionTable.id, current.id),
                eq(TaskRevisionTable.task_id, task.id),
                eq(TaskRevisionTable.status, "active"),
              ),
            )
            .returning()
            .get()
          if (!revision) throw new Conflict()
          const saved = tx
            .update(SessionTaskTable)
            .set({ time_updated: now })
            .where(and(eq(SessionTaskTable.id, task.id), eq(SessionTaskTable.current_revision_id, current.id)))
            .returning()
            .get()
          if (!saved) throw new Conflict()
          return { type: "execute" as const, task: Task.parse(saved), revision: Revision.parse(revision) }
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (constraint(err) || locked(err)) throw new Conflict()
      throw err
    }
  }

  export async function beginDelegated(input: {
    sessionID: SessionID
    parentSessionID: SessionID
    parentRunID: string
    parentActionID: string
    messageID?: MessageID
  }) {
    const assignment = await SessionAssignment.bySource({
      sessionID: input.parentSessionID,
      runID: input.parentRunID,
      actionID: input.parentActionID,
    })
    if (!assignment) throw new Conflict("session_task_delegation_assignment_missing")
    const content = await SessionAssignment.content(assignment.id)
    const plan =
      content && typeof content === "object" && !Array.isArray(content) && "plan" in content ? content.plan : undefined
    if (typeof plan !== "string") throw new Conflict("session_task_delegation_assignment_conflict")
    return transact(
      (tx) => {
        const child = tx
          .select({ parent_id: SessionTable.parent_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
        if (child?.parent_id !== input.parentSessionID) throw new Conflict("session_task_delegation_parent_conflict")
        const locator = {
          assignment,
          sessionID: input.sessionID,
          sourceSessionID: input.parentSessionID,
          runID: input.parentRunID,
          actionIDs: [input.parentActionID],
          source: "delegation" as const,
        }
        if (!SessionAssignment.withCurrent(tx, locator))
          throw new Conflict("session_task_delegation_assignment_missing")
        const current = tx
          .select({ id: SessionTaskTable.id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, input.sessionID))
          .get()
        const saved = write({
          sessionID: input.sessionID,
          messageID: input.messageID,
          ...(current
            ? {}
            : {
                assignment: { op: "create" as const, target: "self" as const, title: assignment.title, body: plan },
                source: {
                  type: "delegation" as const,
                  sessionID: input.parentSessionID,
                  messageID: input.messageID,
                  runID: input.parentRunID,
                  actionID: input.parentActionID,
                },
              }),
          actions: [],
        })
        const source = saved.task.source_ref
        if (
          saved.task.source_type !== "delegation" ||
          source.sessionID !== input.parentSessionID ||
          source.runID !== input.parentRunID ||
          source.actionID !== input.parentActionID
        )
          throw new Conflict("session_task_delegation_source_conflict")
        if (!SessionAssignment.withCurrent(tx, locator))
          throw new Conflict("session_task_delegation_assignment_missing")
        return saved
      },
      { behavior: "immediate" },
    )
  }

  export async function sync(input: { sessionID: SessionID; runID: string; actions?: AgentProtocol.ResultAction[] }) {
    const run = input.actions
      ? { actions: input.actions }
      : await import("./runs").then((item) => item.SessionRuns.persisted(input.sessionID, input.runID))
    if (!run) throw new Conflict("session_task_run_missing")
    return transact(
      (tx) => {
        const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, input.sessionID)).get()
        if (!task?.current_revision_id) throw new Conflict("session_task_missing")
        if (task.status !== "running" && task.status !== "waiting_user") throw new Conflict("session_task_stale_run")
        const revision = tx
          .select()
          .from(TaskRevisionTable)
          .where(eq(TaskRevisionTable.id, task.current_revision_id))
          .get()
        const flow = revision ? bounded(Workflow.parse(revision.workflow)) : undefined
        if (
          !revision ||
          revision.task_id !== task.id ||
          revision.status !== "active" ||
          !flow ||
          !runids(flow).includes(input.runID)
        )
          throw new Conflict("session_task_stale_run")
        const actions = bounded({ ...flow, actions: reconcile(flow.actions, run.actions, input.runID) })
        if (JSON.stringify(actions) === JSON.stringify(revision.workflow)) return Revision.parse(revision)
        const saved = tx
          .update(TaskRevisionTable)
          .set({
            workflow: {
              ...actions,
            },
          })
          .where(
            and(
              eq(TaskRevisionTable.id, revision.id),
              eq(TaskRevisionTable.task_id, task.id),
              eq(TaskRevisionTable.status, "active"),
            ),
          )
          .returning()
          .get()
        if (!saved) throw new Conflict("session_task_stale_run")
        const current = tx
          .update(SessionTaskTable)
          .set({ time_updated: Date.now() })
          .where(
            and(
              eq(SessionTaskTable.id, task.id),
              eq(SessionTaskTable.current_revision_id, revision.id),
              inArray(SessionTaskTable.status, ["running", "waiting_user", "revising"]),
            ),
          )
          .returning({ id: SessionTaskTable.id })
          .get()
        if (!current) throw new Conflict("session_task_stale_run")
        return Revision.parse(saved)
      },
      { behavior: "immediate" },
    )
  }

  export async function finish(raw: z.input<typeof Finish>) {
    const input = Finish.parse(raw)
    const now = Date.now()
    return transact(
      (tx) => {
        const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, input.sessionID)).get()
        if (!task?.current_revision_id) throw new Conflict("session_task_missing")
        if (task.source_type === "delegation" && input.source === "protocol")
          throw new Conflict("session_task_delegated_protocol_result")
        const revision = tx
          .select()
          .from(TaskRevisionTable)
          .where(eq(TaskRevisionTable.id, task.current_revision_id))
          .get()
        if (!revision || revision.workflow.run_id !== input.runID) throw new Conflict("session_task_stale_run")
        if (revision.result !== null || revision.result_source !== null) {
          if (revision.result === input.summary && revision.result_source === input.source)
            return Revision.parse(revision)
          throw new Conflict("session_task_result_conflict")
        }
        const saved = tx
          .update(TaskRevisionTable)
          .set({
            status: input.source === "protocol" ? "completed" : revision.status,
            result: input.summary,
            result_source: input.source,
            time_completed: now,
          })
          .where(and(eq(TaskRevisionTable.id, revision.id), eq(TaskRevisionTable.status, "active")))
          .returning()
          .get()
        if (!saved) throw new Conflict("session_task_result_conflict")
        tx.update(SessionTaskTable)
          .set({ status: input.source === "protocol" ? "completed" : task.status, time_updated: now })
          .where(and(eq(SessionTaskTable.id, task.id), eq(SessionTaskTable.current_revision_id, revision.id)))
          .run()
        return Revision.parse(saved)
      },
      { behavior: "immediate" },
    )
  }

  export async function context(sessionID: SessionID) {
    const stored = await get(sessionID)
    if (!stored) return
    return [
      "<current-session-task>",
      `Task: ${stored.task.id}`,
      `Revision: v${stored.revision.version}`,
      `Status: ${stored.task.status}`,
      `Title: ${stored.revision.title}`,
      "Ordinary conversation does not create or revise a Task.",
      "Use create only when no Task is bound; use update for a draft proposal; use handoff for peer work.",
      "Inspect full task body, history, actions, and results through task_inspect when available.",
      "</current-session-task>",
    ].join("\n")
  }

  export async function create(raw: z.input<typeof Create>) {
    const input = Create.parse(raw)
    const now = Date.now()
    const task = `task_${randomUUID()}`
    const revision = `revision_${randomUUID()}`
    const source = { ...input.source } as Record<string, unknown>
    delete source.type

    try {
      return transact(
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

  export async function inspect(sessionID: SessionID, include: "summary" | "workflow" | "results" = "summary") {
    const stored = await get(sessionID)
    if (!stored) return
    const base = {
      task: {
        id: stored.task.id,
        title: stored.task.title,
        status: stored.task.status,
        session_id: stored.task.session_id,
      },
      revision: {
        id: stored.revision.id,
        version: stored.revision.version,
        status: stored.revision.status,
        title: stored.revision.title,
      },
    }
    if (include === "summary") return base
    if (include === "workflow")
      return { ...base, body: stored.revision.body, workflow: Workflow.parse(stored.revision.workflow) }
    const children = await scope(sessionID)
    const results = await SessionResult.listForParent(sessionID)
    const ids = new Set(children.map((item) => item.session_id))
    return {
      ...base,
      results: results
        .filter((item) => item.child_session_id && ids.has(item.child_session_id))
        .map((item) => ({
          id: item.id,
          child_session_id: item.child_session_id,
          run_id: item.run_id,
          action_id: item.action_id,
          status: item.status,
          reusable: item.satisfying,
          summary: item.summary,
        })),
    }
  }

  export async function scope(sessionID: SessionID) {
    const stored = await get(sessionID)
    if (!stored) return []
    const workflow = Workflow.parse(stored.revision.workflow)
    const parents = workflow.assignment_id ? [workflow.assignment_id] : []
    const actions = new Map(
      workflow.actions.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
        const action = raw as { id?: unknown; run_id?: unknown }
        if (typeof action.id !== "string" || typeof action.run_id !== "string") return []
        return [[`${action.run_id}:${action.id}`, true] as const]
      }),
    )
    const rows = Database.use((tx) =>
      tx.select().from(AssignmentTable).where(eq(AssignmentTable.source_session_id, sessionID)).all(),
    )
    const results = await SessionResult.listForParent(sessionID)
    return rows
      .filter((item) => {
        if (item.source_type !== "delegation") return false
        if (item.parent_id && !parents.includes(item.parent_id)) return false
        if (!item.source_run_id || !item.source_action_id) return false
        return actions.has(`${item.source_run_id}:${item.source_action_id}`)
      })
      .map((item) => ({
        session_id: item.session_id,
        assignment_id: item.id,
        run_id: item.source_run_id!,
        action_id: item.source_action_id!,
        status: SessionStatus.get(item.session_id),
        reusable: results.some(
          (result) =>
            result.child_session_id === item.session_id &&
            result.run_id === item.source_run_id &&
            result.action_id === item.source_action_id &&
            result.satisfying,
        ),
        result_refs: results
          .filter(
            (result) =>
              result.child_session_id === item.session_id &&
              result.run_id === item.source_run_id &&
              result.action_id === item.source_action_id &&
              result.satisfying,
          )
          .map((result) => result.id),
      }))
  }

  export async function draft(raw: z.input<typeof Draft>) {
    const input = Draft.parse(raw)
    const now = Date.now()
    for (const attempt of [0, 1, 2, 3, 4]) {
      try {
        return transact(
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
        if (constraint(err)) throw new Conflict("task_revision_constraint")
        if (!locked(err)) throw err
        if (attempt === 4) throw new Conflict("task_revision_locked")
        await Bun.sleep(10 * 2 ** attempt)
      }
    }
    throw new Conflict("task_revision_locked")
  }

  export async function activate(raw: z.input<typeof Activate>) {
    const input = Activate.parse(raw)
    const now = Date.now()
    try {
      return transact(
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
          const previous = tx
            .select()
            .from(TaskRevisionTable)
            .where(and(eq(TaskRevisionTable.id, task.current_revision_id), eq(TaskRevisionTable.task_id, input.taskID)))
            .get()
          if (!previous) throw new Conflict()
          const meta = archive(tx, task.session_id, previous)
          const lease = tx
            .select({ id: SessionEventOutboxTable.id })
            .from(SessionEventOutboxTable)
            .where(
              and(
                eq(SessionEventOutboxTable.session_id, task.session_id),
                eq(SessionEventOutboxTable.kind, "task_revision_bootstrap"),
                eq(SessionEventOutboxTable.dedupe_key, `task_revision_bootstrap:${task.current_revision_id}`),
                eq(SessionEventOutboxTable.status, "delivering"),
                gt(SessionEventOutboxTable.updated_at, now - 30_000),
              ),
            )
          const archived = tx
            .update(TaskRevisionTable)
            .set({
              status: "archived",
              time_archived: now,
              archive_reason: next.reason ?? "Task revised",
              terminal_status: meta.terminal,
              stopped_child_count: input.stopped,
              result_status: meta.result,
            })
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
                notExists(lease),
              ),
            )
            .returning({ id: SessionTaskTable.id })
            .get()
          if (!updated) {
            if (lease.get()) throw new Conflict("task_revision_bootstrap_delivering")
            throw new Conflict()
          }
          if (input.bootstrap) {
            const key = `task_revision_bootstrap:${revision.id}`
            const found = tx
              .select({ id: SessionEventOutboxTable.id })
              .from(SessionEventOutboxTable)
              .where(eq(SessionEventOutboxTable.dedupe_key, key))
              .get()
            if (!found)
              tx.insert(SessionEventOutboxTable)
                .values({
                  id: `outbox_${randomUUID()}`,
                  session_id: task.session_id,
                  target_session_id: task.session_id,
                  kind: "task_revision_bootstrap",
                  dedupe_key: key,
                  status: "pending",
                  payload: {
                    task_id: updated.id,
                    revision_id: revision.id,
                    message_id: MessageID.ascending(),
                  },
                  created_at: now,
                  updated_at: now,
                  delivered_at: null,
                  acked_at: null,
                  error: null,
                })
                .run()
          }
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
    const results = resultIndex(sessionID)
    return Database.use((tx) =>
      tx
        .select({
          id: TaskRevisionTable.id,
          version: TaskRevisionTable.version,
          status: TaskRevisionTable.status,
          title: TaskRevisionTable.title,
          reason: TaskRevisionTable.reason,
          archive_reason: TaskRevisionTable.archive_reason,
          terminal_status: TaskRevisionTable.terminal_status,
          stopped_child_count: TaskRevisionTable.stopped_child_count,
          result_status: TaskRevisionTable.result_status,
          result: TaskRevisionTable.result,
          result_source: TaskRevisionTable.result_source,
          workflow: TaskRevisionTable.workflow,
          time_created: TaskRevisionTable.time_created,
          time_archived: TaskRevisionTable.time_archived,
        })
        .from(TaskRevisionTable)
        .where(and(eq(TaskRevisionTable.task_id, task.id), eq(TaskRevisionTable.status, "archived")))
        .orderBy(desc(TaskRevisionTable.version))
        .all()
        .map((item) => {
          const status = archiveResult(item, results)
          const saved = result(item.result, item.result_source)
          return History.parse({
            id: item.id,
            version: item.version,
            status: item.status,
            title: item.title,
            reason: item.reason,
            archive_reason: item.archive_reason,
            ...(item.terminal_status === null ? {} : { terminal_status: item.terminal_status }),
            ...(item.stopped_child_count === null ? {} : { stopped_child_count: item.stopped_child_count }),
            result: saved.result
              ? { present: true, ...(status ? { status } : {}) }
              : { present: false },
            time: {
              created: item.time_created,
              ...(item.time_archived === null ? {} : { archived: item.time_archived }),
            },
          })
        }),
    )
  }

  export async function current(sessionID: SessionID) {
    const stored = await get(sessionID)
    if (!stored) return
    const { SessionRuns } = await import("./runs")
    const source = stored.task.source_ref
    const parent =
      stored.task.source_type === "delegation" && typeof source.runID === "string" ? source.runID : undefined
    const ids = parent ? [parent] : runids(stored.revision.workflow)
    const recent = ids.slice(-50)
    const runs = await Promise.all(
      recent.map((runID) => SessionRuns.persisted(sessionID, runID).catch(() => undefined)),
    )
    const trusted = parent ? valid(stored.task, runs[0]) : undefined
    const merged = runs.reduce<unknown[]>(
      (all, run, index) => (run ? merge(all, tagged(run.actions, recent[index]!)) : all),
      workflow(stored.revision.workflow).filter((item) => recent.includes(item.run_id)),
    )
    const actions = parent ? workflow(stored.revision.workflow) : workflow({ actions: merged })
    const output = parent
      ? trusted?.summary
        ? result(trusted.summary, trusted.summary_source)
        : {}
      : result(stored.revision.result, stored.revision.result_source)
    const { SessionTaskHandoff } = await import("./task-handoff")
    return View.parse({
      id: stored.task.id,
      session_id: stored.task.session_id,
      title: stored.revision.title,
      version: stored.revision.version,
      status: stored.task.status,
      body: stored.revision.body,
      progress: {
        completed:
          (stored.revision.workflow.compact?.completed ?? 0) +
          actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
        total: (stored.revision.workflow.compact?.total ?? 0) + actions.length,
      },
      actions,
      ...output,
      handoffs: SessionTaskHandoff.summaries({ tasks: [stored.task.id], sessionID }),
      time: {
        created: stored.task.time_created,
        updated: stored.task.time_updated,
        ...(stored.revision.time_completed === null ? {} : { completed: stored.revision.time_completed }),
      },
    })
  }

  export async function open(sessionID: SessionID) {
    const bound = await current(sessionID)
    if (bound) return bound
    const { SessionRuns } = await import("./runs")
    const runs = await SessionRuns.persistedList(sessionID)
    if (!runs.length) return
    if (runs.length > 1)
      return LegacyMigration.parse({
        type: "legacy_multi_run",
        count: runs.length,
        proposal: {
          status: "pending_confirmation",
          session_id: sessionID,
          runs: runs.map((run) => ({
            run_id: run.run_id,
            title: run.title ?? "Legacy task",
            status: run.status,
            ...(run.summary && run.summary_source ? { result: run.summary, result_source: run.summary_source } : {}),
            time: run.time,
          })),
        },
      })
    await migrate(sessionID, runs[0]!)
    return current(sessionID)
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
    const classified = archiveResult(item, resultIndex(sessionID))
    const { SessionTaskHandoff } = await import("./task-handoff")
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
      ...(classified ? { result_status: classified } : {}),
      ...(item.terminal_status === null ? {} : { terminal_status: item.terminal_status }),
      ...(item.stopped_child_count === null ? {} : { stopped_child_count: item.stopped_child_count }),
      reason: item.reason,
      archive_reason: item.archive_reason,
      handoffs: SessionTaskHandoff.summaries({ tasks: [row.task.id], sessionID }),
      time: {
        created: item.time_created,
        ...(item.time_activated === null ? {} : { activated: item.time_activated }),
        ...(item.time_completed === null ? {} : { completed: item.time_completed }),
        ...(item.time_archived === null ? {} : { archived: item.time_archived }),
      },
    })
  }

  export function summaries(ids: SessionID[]) {
    if (ids.length === 0) return new Map<SessionID, Summary>()
    const rows = Database.use((db) =>
      db
        .select({ task: SessionTaskTable, revision: TaskRevisionTable })
        .from(SessionTaskTable)
        .innerJoin(
          TaskRevisionTable,
          and(
            eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id),
            eq(TaskRevisionTable.task_id, SessionTaskTable.id),
          ),
        )
        .where(inArray(SessionTaskTable.session_id, ids))
        .all(),
    )
    return new Map(
      rows.map((row) => {
        const flow = Workflow.parse(row.revision.workflow)
        const actions = workflow(flow)
        return [
          row.task.session_id,
          Summary.parse({
            id: row.task.id,
            title: row.revision.title,
            version: row.revision.version,
            status: row.task.status,
            completed_actions:
              (flow.compact?.completed ?? 0) +
              actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
            total_actions: (flow.compact?.total ?? 0) + actions.length,
          }),
        ]
      }),
    )
  }

  export function owns(sessionID: SessionID, revisionID: string) {
    return Database.use(
      (db) =>
        !!db
          .select({ id: TaskRevisionTable.id })
          .from(TaskRevisionTable)
          .innerJoin(SessionTaskTable, eq(SessionTaskTable.id, TaskRevisionTable.task_id))
          .where(and(eq(SessionTaskTable.session_id, sessionID), eq(TaskRevisionTable.id, revisionID)))
          .get(),
    )
  }

  export async function legacy(sessionID: SessionID) {
    const { SessionRuns } = await import("./runs")
    const runs = await SessionRuns.persistedList(sessionID)
    if (!runs.length) return
    if (runs.length > 1) return { type: "legacy_multi_run" as const, count: runs.length }
    const run = runs[0]!
    const actions = workflow({ actions: tagged(run.actions, run.run_id) })
    const { SessionTaskHandoff } = await import("./task-handoff")
    return LegacyView.parse({
      type: "legacy_task",
      id: run.run_id,
      session_id: sessionID,
      title: run.title ?? "Legacy task",
      version: 1,
      status: run.status,
      body: run.task,
      progress: {
        completed: actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
        total: actions.length,
      },
      actions,
      ...(run.summary && run.summary_source ? { result: run.summary, result_source: run.summary_source } : {}),
      handoffs: SessionTaskHandoff.summaries({ sessionID }),
      time: {
        created: run.time.started,
        updated: run.time.completed ?? run.time.started,
        ...(run.time.completed === undefined ? {} : { completed: run.time.completed }),
      },
    })
  }

  async function migrate(sessionID: SessionID, run: SessionRuns.Run) {
    const now = Date.now()
    const task = `task_${randomUUID()}`
    const revision = `revision_${randomUUID()}`
    const key = `legacy-task:${sessionID}:${run.run_id}`
    const actions = tagged(run.actions, run.run_id)
    const terminal = run.status === "completed" || run.status === "failed"
    try {
      return transact(
        (tx) => {
          const found = tx
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.session_id, sessionID))
            .get()
          if (found) return found
          tx.insert(SessionTaskTable)
            .values({
              id: task,
              session_id: sessionID,
              title: run.title ?? "Legacy task",
              status: run.status,
              current_revision_id: null,
              source_type: "legacy",
              source_ref: { runID: run.run_id, dedupe_key: key },
              time_created: run.time.started,
              time_updated: run.time.completed ?? now,
            })
            .run()
          tx.insert(TaskRevisionTable)
            .values({
              id: revision,
              task_id: task,
              version: 1,
              previous_id: null,
              status: run.status === "failed" ? "failed" : run.status === "completed" ? "completed" : "active",
              title: run.title ?? "Legacy task",
              body: run.task,
              body_hash: hash(run.task),
              source_message_id: null,
              reason: "Migrated from one legacy Run",
              workflow: { actions, run_id: run.run_id, run_ids: [run.run_id] },
              result: run.summary ?? null,
              result_source: run.summary_source ?? null,
              time_created: run.time.started,
              time_activated: run.time.started,
              time_completed: terminal ? (run.time.completed ?? now) : null,
              time_archived: null,
              archive_reason: null,
              terminal_status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : null,
              stopped_child_count: null,
              result_status: run.summary
                ? run.status === "failed"
                  ? "failed"
                  : run.summary_source === "fallback_summary" || run.status === "blocked"
                    ? "partial"
                    : "completed"
                : null,
            })
            .run()
          const saved = tx
            .update(SessionTaskTable)
            .set({ current_revision_id: revision })
            .where(eq(SessionTaskTable.id, task))
            .returning()
            .get()
          Database.effect(() =>
            TaskDocuments.publish({
              sessionID,
              taskID: task,
              version: 1,
              title: run.title ?? "Legacy task",
              body: run.task,
              current: true,
            }),
          )
          return saved
        },
        { behavior: "immediate" },
      )
    } catch (err) {
      if (!constraint(err) && !locked(err) && !(err instanceof Conflict)) throw err
      const found = await get(sessionID)
      if (found?.task.source_type === "legacy" && found.task.source_ref.dedupe_key === key) return found.task
      if (found) return found.task
      throw new Conflict("legacy_task_migration_conflict")
    }
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

  function archive(tx: Database.TxOrDb, sessionID: SessionID, revision: typeof TaskRevisionTable.$inferSelect) {
    const flow = Workflow.parse(revision.workflow)
    const actions = workflow(flow)
    const keys = new Set(
      actions
        .filter((item) => item.executor.type === "agent")
        .map((item) => `${item.run_id}:${item.id}`),
    )
    const runs = new Set([...(flow.run_ids ?? []), ...(flow.run_id ? [flow.run_id] : [])])
    const scoped = tx
      .select({
        parent: AssignmentTable.parent_id,
        child: AssignmentTable.session_id,
        run: AssignmentTable.source_run_id,
        action: AssignmentTable.source_action_id,
      })
      .from(AssignmentTable)
      .where(
        and(
          eq(AssignmentTable.source_session_id, sessionID),
          eq(AssignmentTable.source_type, "delegation"),
        ),
      )
      .all()
      .filter((item): item is typeof item & { run: string; action: string } => {
        if (!item.run || !item.action) return false
        const key = `${item.run}:${item.action}`
        if (!flow.assignment_id) return item.parent === null && keys.has(key)
        if (actions.length > 0) return item.parent === flow.assignment_id && keys.has(key)
        return (item.parent === flow.assignment_id || item.parent === null) && runs.has(item.run)
      })
    const located = locators(scoped)
    const rows = tx
      .select({
        run: SessionResultTable.run_id,
        action: SessionResultTable.action_id,
        child: SessionResultTable.child_session_id,
        status: SessionResultTable.status,
      })
      .from(SessionResultTable)
      .where(eq(SessionResultTable.parent_session_id, sessionID))
      .all()
      .filter(
        (item) =>
          item.run &&
          item.action &&
          item.child &&
          located.values.get(`${item.run}:${item.action}`) === item.child,
      )
    const saved = result(revision.result, revision.result_source)
    const expected = actions.length > 0 ? keys : new Set(located.values.keys())
    const complete =
      !located.ambiguous &&
      [...expected].every((key) => {
        const child = located.values.get(key)
        if (!child) return false
        return rows.some((row) => row.child === child && `${row.run}:${row.action}` === key)
      })
    const resultStatus = rows.some((item) => item.status === "failed")
      ? ("failed" as const)
      : !complete
        ? rows.length > 0
          ? ("partial" as const)
          : undefined
        : rows.some((item) => item.status !== "completed") || saved.result_source === "fallback_summary"
        ? ("partial" as const)
        : rows.length > 0 || saved.result
          ? ("completed" as const)
          : undefined
    const progress = {
      completed:
        (flow.compact?.completed ?? 0) +
        actions.filter((item) => item.status === "completed" || item.status === "skipped").length,
      total: (flow.compact?.total ?? 0) + actions.length,
    }
    const terminal =
      actions.some((item) => item.status === "failed") || resultStatus === "failed"
        ? ("failed" as const)
        : actions.some((item) => item.status === "blocked" || item.status === "pending" || item.status === "running") ||
            rows.some((item) => item.status === "blocked" || item.status === "waiting_user")
          ? ("blocked" as const)
          : !complete
            ? ("blocked" as const)
          : progress.total > 0
            ? progress.completed >= progress.total
              ? ("completed" as const)
              : ("blocked" as const)
            : resultStatus === "completed"
              ? ("completed" as const)
              : expected.size > 0 && resultStatus === "partial"
                ? ("completed" as const)
                : ("blocked" as const)
    return { terminal, result: resultStatus }
  }

  function archiveResult(
    item: {
      result: string | null
      result_source: string | null
      result_status: string | null
      workflow: Record<string, unknown>
    },
    results: Map<string, string[]>,
  ) {
    const stored = ArchiveResult.safeParse(item.result_status)
    if (stored.success) return stored.data
    const saved = result(item.result, item.result_source)
    if (!saved.result) return
    if (saved.result_source === "fallback_summary") return "partial" as const
    if (saved.result_source === "protocol") return "completed" as const
    const keys = new Set(
      Workflow.parse(item.workflow).actions.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
        const action = raw as { id?: unknown; run_id?: unknown }
        if (typeof action.id !== "string" || typeof action.run_id !== "string") return []
        return [`${action.run_id}:${action.id}`]
      }),
    )
    if (keys.size !== 1) return
    const rows = [...keys].flatMap((key) => results.get(key) ?? [])
    if (rows.length !== 1) return
    if (rows[0] === "completed") return "completed" as const
    if (rows[0] === "failed" || rows[0] === "aborted") return "failed" as const
    if (["partial", "blocked", "waiting_user", "terminal_reply"].includes(rows[0] ?? "")) return "partial" as const
  }

  function resultIndex(sessionID: SessionID) {
    const rows = Database.use((tx) =>
      tx
        .select({ run: SessionResultTable.run_id, action: SessionResultTable.action_id, status: SessionResultTable.status })
        .from(SessionResultTable)
        .where(
          and(
            eq(SessionResultTable.parent_session_id, sessionID),
            eq(SessionResultTable.carrier, "action_result"),
          ),
        )
        .all(),
    )
    return new Map(
      [
        ...Map.groupBy(
          rows.filter((row): row is typeof row & { run: string; action: string } => !!row.run && !!row.action),
          (row) => `${row.run}:${row.action}`,
        ),
      ].map(([key, items]) => [key, items.map((item) => item.status as string)]),
    )
  }

  function workflow(value: Workflow) {
    return value.actions.flatMap((item) => {
      const parsed = TaskAction.safeParse(item)
      if (parsed.success) return [parsed.data]
      const legacy = AgentProtocol.ResultAction.safeParse(item)
      if (!legacy.success || !value.run_id) return []
      return [{ ...legacy.data, run_id: value.run_id }]
    })
  }

  function flow(actions: unknown[], runID?: string, assignmentID?: string): Workflow {
    const assignment = assignmentID ? { assignment_id: assignmentID } : {}
    if (!runID) return { actions, ...assignment }
    return { actions: tagged(actions, runID), ...assignment, run_id: runID, run_ids: [runID] }
  }

  function bound(
    revisions: (typeof TaskRevisionTable.$inferSelect)[],
    assignment: SessionAssignment.Info,
    compatible: boolean,
  ) {
    const exact = revisions.find((item) => Workflow.parse(item.workflow).assignment_id === assignment.id)
    if (exact) return exact
    if (!compatible) return
    const legacy = revisions.filter((item) => {
      const flow = Workflow.parse(item.workflow)
      const message = assignment.source_message_id && item.source_message_id === assignment.source_message_id
      const run = assignment.source_run_id && flow.run_id === assignment.source_run_id
      return flow.assignment_id === undefined && (message || run)
    })
    if (legacy.length !== 1) return
    return legacy[0]
  }

  function runids(value: Workflow) {
    if (value.run_ids?.length) return [...new Set(value.run_ids)]
    return value.run_id ? [value.run_id] : []
  }

  function bounded(value: Workflow) {
    const ids = runids(value)
    if (ids.length <= 50) return value
    const keep = ids.slice(-50)
    const dropped = new Set(ids.slice(0, -50))
    const removed = value.actions.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).run_id === "string" &&
        dropped.has((item as Record<string, string>).run_id),
    )
    const compact = value.compact ?? { runs: 0, completed: 0, total: 0 }
    return {
      actions: value.actions.filter(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof (item as Record<string, unknown>).run_id !== "string" ||
          !dropped.has((item as Record<string, string>).run_id),
      ),
      ...(value.assignment_id ? { assignment_id: value.assignment_id } : {}),
      run_id: keep.at(-1),
      run_ids: keep,
      compact: {
        runs: compact.runs + dropped.size,
        completed:
          compact.completed +
          removed.filter(
            (item) =>
              item &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              ((item as Record<string, unknown>).status === "completed" ||
                (item as Record<string, unknown>).status === "skipped"),
          ).length,
        total: compact.total + removed.length,
      },
    }
  }

  function merge(prev: unknown[], next: unknown[]) {
    const items = new Map<string, unknown>()
    const rest: unknown[] = []
    for (const item of [...prev, ...next]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        rest.push(item)
        continue
      }
      const id = (item as { id?: unknown }).id
      if (typeof id !== "string" || !id) {
        rest.push(item)
        continue
      }
      const run = (item as { run_id?: unknown }).run_id
      const key = `${typeof run === "string" ? run : "legacy"}\u0000${id}`
      if (items.has(key) && real(items.get(key))) {
        if (!real(item)) continue
      }
      items.set(key, item)
    }
    return [...items.values(), ...rest]
  }

  function reconcile(prev: unknown[], next: unknown[], runID: string) {
    const actions = [...prev]
    for (const item of tagged(next, runID)) {
      const parsed = TaskAction.safeParse(item)
      if (!parsed.success) throw new Conflict("session_task_action_conflict")
      const index = actions.findIndex(
        (saved) =>
          saved &&
          typeof saved === "object" &&
          !Array.isArray(saved) &&
          (saved as Record<string, unknown>).run_id === parsed.data.run_id &&
          (saved as Record<string, unknown>).id === parsed.data.id,
      )
      if (index < 0) {
        actions.push(parsed.data)
        continue
      }
      const saved = TaskAction.safeParse(actions[index])
      if (!saved.success) {
        actions[index] = parsed.data
        continue
      }
      if (JSON.stringify(saved.data) === JSON.stringify(parsed.data)) continue
      throw new Conflict("session_task_action_conflict")
    }
    return actions
  }

  function tagged(actions: unknown[], runID: string) {
    return actions.map((item) =>
      item && typeof item === "object" && !Array.isArray(item) ? { ...item, run_id: runID } : item,
    )
  }

  function real(item: unknown) {
    return TaskAction.safeParse(item).success || AgentProtocol.ResultAction.safeParse(item).success
  }

  function orchestration(actions: unknown[]) {
    if (actions.length === 0) return false
    return actions.every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
      const item = raw as { executor?: { type?: unknown; target?: unknown } }
      if (item.executor?.type !== "tool") return false
      return item.executor.target === "task_inspect" || item.executor.target === "session_control"
    })
  }

  function transact<T>(fn: (tx: Database.TxOrDb) => T, config?: { behavior?: "deferred" | "immediate" | "exclusive" }) {
    try {
      return Database.transaction(fn, config)
    } catch (err) {
      if (err instanceof Conflict) throw err
      if (constraint(err) || locked(err)) throw new Conflict()
      throw err
    }
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
