import z from "zod"
import { randomUUID } from "crypto"
import { SQLiteError } from "bun:sqlite"
import { Database, and, asc, desc, eq, gt, max, sql } from "../storage/db"
import { SessionID } from "./schema"
import { TaskLedgerAudit } from "./task-ledger-audit"
import {
  AssignmentTable,
  SessionResultTable,
  SessionTaskTable,
  TaskCommandTable,
  TaskEventTable,
  TaskRequirementTable,
  TaskRevisionTable,
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

  export const AuditIssue = TaskLedgerAudit.Issue
  export type AuditIssue = TaskLedgerAudit.Issue
  export const Audit = TaskLedgerAudit.Result
  export type Audit = TaskLedgerAudit.Result

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
  const Record = z
    .object({
      task_id: TaskID,
      revision_id: RevisionID,
      command_key: z.string().min(1),
      source_refs: z.array(z.string().min(1)),
      body_ref: z.string().min(1),
      body_hash: Hash,
      spec_ref: z.string().min(1),
      spec_hash: Hash,
      spec_size: z.number().int().nonnegative(),
      plan: z
        .object({
          ref: z.string().min(1),
          hash: Hash,
          size: z.number().int().nonnegative(),
          producer_id: z.string().min(1),
        })
        .strict()
        .optional(),
      created_by: z.enum(["user", "agent", "migration"]),
      confirmed_at: Time.nullable(),
      time_created: Time,
    })
    .strict()
  const Revise = Record.omit({
    command_key: true,
  }).extend({
    command_id: ID("command"),
    supersedes_id: ID("requirement"),
  })
  const Activate = z
    .object({
      task_id: TaskID,
      previous_id: RevisionID,
      revision_id: RevisionID,
      command_id: ID("command"),
      source: z.enum(["direct", "recovery"]),
    })
    .strict()
  const Sync = z
    .object({
      task_id: TaskID,
      revision_id: RevisionID,
      command_id: ID("command"),
      run_id: z.string().min(1),
      actions: z.record(
        z.enum(["pending", "running", "completed", "blocked", "failed", "skipped"]),
        z.number().int().nonnegative(),
      ),
    })
    .strict()
  const Result = z
    .object({
      task_id: TaskID,
      revision_id: RevisionID,
      command_id: ID("command"),
      run_id: z.string().min(1),
      source: z.enum(["protocol", "action_result", "fallback_summary"]),
      result_ref: z.string().min(1),
      locator: z
        .object({
          id: z.string().min(1),
          parent_session_id: SessionID.zod,
          child_session_id: SessionID.zod,
          run_id: z.string().min(1),
          action_id: z.string().min(1),
          carrier: z.enum(["action_result", "fallback_summary"]),
        })
        .strict()
        .optional(),
      terminal: z.enum(["completed", "blocked", "failed"]).optional(),
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

  export function record(tx: Database.Transaction, input: z.input<typeof Record>) {
    const parsed = Record.parse(input)
    const command = claim(tx, {
      task_id: parsed.task_id,
      kind: "task.create",
      idempotency_key: parsed.command_key,
    })
    if (command.status === "applied") return { command, replay: true as const }
    const requirement = Requirement.parse(
      tx
        .insert(TaskRequirementTable)
        .values({
          id: `requirement_${randomUUID()}`,
          task_id: parsed.task_id,
          version: 1,
          source_refs: [...new Set(parsed.source_refs)],
          body_ref: parsed.body_ref,
          body_hash: parsed.body_hash,
          constraints: {},
          acceptance: [],
          created_by: parsed.created_by,
          confirmed_at: parsed.confirmed_at,
          supersedes_id: null,
          time_created: parsed.time_created,
        })
        .returning()
        .get(),
    )
    const resources = [
      Resource.parse(
        tx
          .insert(TaskResourceTable)
          .values({
            id: `resource_${randomUUID()}`,
            task_id: parsed.task_id,
            revision_id: parsed.revision_id,
            kind: "spec",
            uri: parsed.spec_ref,
            hash: parsed.spec_hash,
            size: parsed.spec_size,
            summary: null,
            producer_type: "revision",
            producer_id: parsed.revision_id,
            visibility: "task",
            lifecycle: "active",
            time_created: parsed.time_created,
          })
          .returning()
          .get(),
      ),
      ...(parsed.plan
        ? [
            Resource.parse(
              tx
                .insert(TaskResourceTable)
                .values({
                  id: `resource_${randomUUID()}`,
                  task_id: parsed.task_id,
                  revision_id: parsed.revision_id,
                  kind: "plan",
                  uri: parsed.plan.ref,
                  hash: parsed.plan.hash,
                  size: parsed.plan.size,
                  summary: null,
                  producer_type: "assignment",
                  producer_id: parsed.plan.producer_id,
                  visibility: "task",
                  lifecycle: "active",
                  time_created: parsed.time_created,
                })
                .returning()
                .get(),
            ),
          ]
        : []),
    ]
    const task = tx
      .update(SessionTaskTable)
      .set({ requirement_id: requirement.id })
      .where(eq(SessionTaskTable.id, parsed.task_id))
      .returning({ id: SessionTaskTable.id })
      .get()
    const revision = tx
      .update(TaskRevisionTable)
      .set({
        requirement_id: requirement.id,
        spec_ref: parsed.spec_ref,
        plan_ref: parsed.plan?.ref ?? null,
      })
      .where(and(eq(TaskRevisionTable.task_id, parsed.task_id), eq(TaskRevisionTable.id, parsed.revision_id)))
      .returning({ id: TaskRevisionTable.id })
      .get()
    if (!task || !revision) throw new Conflict("task_create_target_missing")
    const refs = resources.map((item) => item.id)
    const events = append(tx, parsed.task_id, [
      {
        type: "task.created",
        revision_id: parsed.revision_id,
        command_id: command.id,
        resource_refs: refs,
      },
      {
        type: "requirement.recorded",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: { requirement_id: requirement.id, version: requirement.version },
        resource_refs: parsed.plan ? [resources[1]!.id] : [resources[0]!.id],
      },
      {
        type: "revision.activated",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: { version: 1 },
        resource_refs: refs,
      },
    ])
    return {
      command: apply(tx, command.id, `task://${parsed.task_id}`),
      events,
      requirement,
      resources,
      replay: false as const,
    }
  }

  export function revise(tx: Database.Transaction, input: z.input<typeof Revise>) {
    const parsed = Revise.parse(input)
    const command = tx.select().from(TaskCommandTable).where(eq(TaskCommandTable.id, parsed.command_id)).limit(1).get()
    if (
      !command ||
      command.task_id !== parsed.task_id ||
      command.kind !== "task.revise" ||
      command.status !== "accepted"
    )
      throw new Conflict("task_revision_command_invalid")
    const version =
      (tx
        .select({ value: max(TaskRequirementTable.version) })
        .from(TaskRequirementTable)
        .where(eq(TaskRequirementTable.task_id, parsed.task_id))
        .get()?.value ?? 0) + 1
    const requirement = Requirement.parse(
      tx
        .insert(TaskRequirementTable)
        .values({
          id: `requirement_${randomUUID()}`,
          task_id: parsed.task_id,
          version,
          source_refs: [...new Set(parsed.source_refs)],
          body_ref: parsed.body_ref,
          body_hash: parsed.body_hash,
          constraints: {},
          acceptance: [],
          created_by: parsed.created_by,
          confirmed_at: parsed.confirmed_at,
          supersedes_id: parsed.supersedes_id,
          time_created: parsed.time_created,
        })
        .returning()
        .get(),
    )
    const resources = [
      Resource.parse(
        tx
          .insert(TaskResourceTable)
          .values({
            id: `resource_${randomUUID()}`,
            task_id: parsed.task_id,
            revision_id: parsed.revision_id,
            kind: "spec",
            uri: parsed.spec_ref,
            hash: parsed.spec_hash,
            size: parsed.spec_size,
            summary: null,
            producer_type: "revision",
            producer_id: parsed.revision_id,
            visibility: "task",
            lifecycle: "active",
            time_created: parsed.time_created,
          })
          .returning()
          .get(),
      ),
      ...(parsed.plan
        ? [
            Resource.parse(
              tx
                .insert(TaskResourceTable)
                .values({
                  id: `resource_${randomUUID()}`,
                  task_id: parsed.task_id,
                  revision_id: parsed.revision_id,
                  kind: "plan",
                  uri: parsed.plan.ref,
                  hash: parsed.plan.hash,
                  size: parsed.plan.size,
                  summary: null,
                  producer_type: "assignment",
                  producer_id: parsed.plan.producer_id,
                  visibility: "task",
                  lifecycle: "active",
                  time_created: parsed.time_created,
                })
                .returning()
                .get(),
            ),
          ]
        : []),
    ]
    const revision = tx
      .update(TaskRevisionTable)
      .set({
        requirement_id: requirement.id,
        spec_ref: parsed.spec_ref,
        plan_ref: parsed.plan?.ref ?? null,
      })
      .where(
        and(
          eq(TaskRevisionTable.task_id, parsed.task_id),
          eq(TaskRevisionTable.id, parsed.revision_id),
          eq(TaskRevisionTable.status, "draft"),
        ),
      )
      .returning({ id: TaskRevisionTable.id })
      .get()
    if (!revision) throw new Conflict("task_revision_target_missing")
    const refs = resources.map((item) => item.id)
    const events = append(tx, parsed.task_id, [
      {
        type: "requirement.revised",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: {
          requirement_id: requirement.id,
          supersedes_id: requirement.supersedes_id,
          version: requirement.version,
        },
        resource_refs: parsed.plan ? [resources[1]!.id] : [resources[0]!.id],
      },
      {
        type: "revision.created",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: { version },
        resource_refs: refs,
      },
      {
        type: "revision.drafted",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: { version },
        resource_refs: refs,
      },
    ])
    return {
      command: apply(tx, command.id, `revision://${parsed.revision_id}`),
      events,
      requirement,
      resources,
    }
  }

  export function activate(tx: Database.Transaction, input: z.input<typeof Activate>) {
    const parsed = Activate.parse(input)
    const command = tx.select().from(TaskCommandTable).where(eq(TaskCommandTable.id, parsed.command_id)).limit(1).get()
    if (
      !command ||
      command.task_id !== parsed.task_id ||
      command.kind !== "revision.activate" ||
      command.status !== "accepted"
    )
      throw new Conflict("task_revision_command_invalid")
    const archived = tx
      .update(TaskResourceTable)
      .set({ lifecycle: "archived" })
      .where(
        and(
          eq(TaskResourceTable.task_id, parsed.task_id),
          eq(TaskResourceTable.revision_id, parsed.previous_id),
          eq(TaskResourceTable.lifecycle, "active"),
        ),
      )
      .returning()
      .all()
      .map((row) => Resource.parse(row))
    const active = tx
      .select()
      .from(TaskResourceTable)
      .where(
        and(
          eq(TaskResourceTable.task_id, parsed.task_id),
          eq(TaskResourceTable.revision_id, parsed.revision_id),
          eq(TaskResourceTable.lifecycle, "active"),
        ),
      )
      .all()
      .map((row) => Resource.parse(row))
    const events = append(tx, parsed.task_id, [
      {
        type: "revision.archived",
        revision_id: parsed.previous_id,
        command_id: command.id,
        data: { activation_source: parsed.source },
        resource_refs: archived.map((item) => item.id),
      },
      {
        type: "revision.activated",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: { activation_source: parsed.source },
        resource_refs: active.map((item) => item.id),
      },
    ])
    return {
      archived,
      command: apply(tx, command.id, `revision://${parsed.revision_id}`),
      events,
    }
  }

  export function sync(tx: Database.Transaction, input: z.input<typeof Sync>) {
    const parsed = Sync.parse(input)
    const command = tx.select().from(TaskCommandTable).where(eq(TaskCommandTable.id, parsed.command_id)).limit(1).get()
    if (
      !command ||
      command.task_id !== parsed.task_id ||
      command.kind !== "task.workflow.sync" ||
      command.status !== "accepted"
    )
      throw new Conflict("task_workflow_command_invalid")
    const task = tx
      .select({ revision_id: SessionTaskTable.current_revision_id, status: TaskRevisionTable.status })
      .from(SessionTaskTable)
      .innerJoin(
        TaskRevisionTable,
        and(
          eq(TaskRevisionTable.task_id, SessionTaskTable.id),
          eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id),
        ),
      )
      .where(eq(SessionTaskTable.id, parsed.task_id))
      .get()
    if (task?.revision_id !== parsed.revision_id || task.status !== "active")
      throw new Conflict("task_workflow_state_invalid")
    const events = append(tx, parsed.task_id, [
      {
        type: "task.workflow_synced",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data: {
          run_id: parsed.run_id,
          run_count: 1,
          action_count: Object.values(parsed.actions).reduce((sum, count) => sum + count, 0),
          actions: parsed.actions,
        },
      },
    ])
    return {
      command: apply(tx, command.id, `task://${parsed.task_id}/revision/${parsed.revision_id}/workflow`),
      events,
    }
  }

  export function result(tx: Database.Transaction, input: z.input<typeof Result>) {
    const parsed = Result.parse(input)
    const command = tx.select().from(TaskCommandTable).where(eq(TaskCommandTable.id, parsed.command_id)).limit(1).get()
    if (
      !command ||
      command.task_id !== parsed.task_id ||
      command.kind !== "task.finish" ||
      command.status !== "accepted"
    )
      throw new Conflict("task_result_command_invalid")
    const task = tx
      .select({
        revision_id: SessionTaskTable.current_revision_id,
        task_status: SessionTaskTable.status,
        revision_status: TaskRevisionTable.status,
        result: TaskRevisionTable.result,
        source: TaskRevisionTable.result_source,
        session_id: SessionTaskTable.session_id,
        source_type: SessionTaskTable.source_type,
        source_ref: SessionTaskTable.source_ref,
        workflow: TaskRevisionTable.workflow,
      })
      .from(SessionTaskTable)
      .innerJoin(
        TaskRevisionTable,
        and(
          eq(TaskRevisionTable.task_id, SessionTaskTable.id),
          eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id),
        ),
      )
      .where(eq(SessionTaskTable.id, parsed.task_id))
      .get()
    if (
      task?.revision_id !== parsed.revision_id ||
      !task.result ||
      task.source !== parsed.source ||
      (!parsed.terminal && task.revision_status !== "active") ||
      (parsed.terminal && task.task_status !== parsed.terminal) ||
      (parsed.terminal === "completed" && task.revision_status !== "completed") ||
      (parsed.terminal === "failed" && task.revision_status !== "failed") ||
      (parsed.terminal === "blocked" && task.revision_status !== "active")
    )
      throw new Conflict("task_result_state_invalid")
    const fallback = `task://${parsed.task_id}/revision/${parsed.revision_id}/result`
    if (!parsed.locator && parsed.result_ref !== fallback) throw new Conflict("task_result_ref_invalid")
    if (parsed.locator) {
      if (parsed.result_ref !== `session-result://${parsed.locator.id}` || parsed.locator.carrier !== parsed.source)
        throw new Conflict("task_result_ref_invalid")
      const row = tx.select().from(SessionResultTable).where(eq(SessionResultTable.id, parsed.locator.id)).get()
      if (
        !row ||
        row.session_id !== parsed.locator.child_session_id ||
        row.parent_session_id !== parsed.locator.parent_session_id ||
        row.child_session_id !== parsed.locator.child_session_id ||
        row.run_id !== parsed.locator.run_id ||
        row.action_id !== parsed.locator.action_id ||
        row.carrier !== parsed.locator.carrier
      )
        throw new Conflict("task_result_locator_invalid")
      const source =
        task.source_ref && typeof task.source_ref === "object" && !Array.isArray(task.source_ref)
          ? task.source_ref
          : {}
      const delegated =
        task.source_type === "delegation" &&
        task.session_id === parsed.locator.child_session_id &&
        source.sessionID === parsed.locator.parent_session_id &&
        source.runID === parsed.locator.run_id &&
        source.actionID === parsed.locator.action_id
      const flow =
        task.workflow && typeof task.workflow === "object" && !Array.isArray(task.workflow) ? task.workflow : {}
      const action =
        Array.isArray(flow.actions) &&
        flow.actions.some(
          (item) =>
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            item.run_id === parsed.locator!.run_id &&
            item.id === parsed.locator!.action_id &&
            item.executor &&
            typeof item.executor === "object" &&
            !Array.isArray(item.executor) &&
            item.executor.type === "agent",
        )
      const assignment =
        task.source_type === "delegation"
          ? undefined
          : tx
              .select()
              .from(AssignmentTable)
              .where(
                and(
                  eq(AssignmentTable.source_type, "delegation"),
                  eq(AssignmentTable.source_session_id, task.session_id),
                  eq(AssignmentTable.session_id, parsed.locator.child_session_id),
                  eq(AssignmentTable.source_run_id, parsed.locator.run_id),
                  eq(AssignmentTable.source_action_id, parsed.locator.action_id),
                ),
              )
              .all()
              .find((item) => item.parent_id === (typeof flow.assignment_id === "string" ? flow.assignment_id : null))
      if (!delegated && (!action || !assignment)) throw new Conflict("task_result_locator_unowned")
    }
    const data = {
      run_id: parsed.run_id,
      source: parsed.source,
      result_ref: parsed.result_ref,
    }
    const events = append(tx, parsed.task_id, [
      {
        type: "result.recorded",
        revision_id: parsed.revision_id,
        command_id: command.id,
        data,
      },
      ...(parsed.terminal
        ? [
            {
              type: `task.${parsed.terminal}`,
              revision_id: parsed.revision_id,
              command_id: command.id,
              data,
            },
          ]
        : []),
    ])
    return {
      command: apply(tx, command.id, parsed.result_ref),
      events,
    }
  }

  export function ensure(
    tx: Database.Transaction,
    task: typeof SessionTaskTable.$inferSelect,
    revision: typeof TaskRevisionTable.$inferSelect,
  ) {
    if (task.current_revision_id !== revision.id || revision.task_id !== task.id)
      throw new Conflict("task_migration_revision_invalid")
    const spec = `task://${task.id}/revision/${revision.id}`
    const flow =
      revision.workflow && typeof revision.workflow === "object" && !Array.isArray(revision.workflow)
        ? revision.workflow
        : {}
    const source =
      task.source_ref && typeof task.source_ref === "object" && !Array.isArray(task.source_ref)
        ? task.source_ref
        : {}
    const assignments =
      typeof flow.assignment_id === "string"
        ? tx
            .select()
            .from(AssignmentTable)
            .where(and(eq(AssignmentTable.id, flow.assignment_id), eq(AssignmentTable.session_id, task.session_id)))
            .limit(2)
            .all()
        : task.source_type === "delegation" &&
            typeof source.sessionID === "string" &&
            typeof source.runID === "string" &&
            typeof source.actionID === "string"
          ? tx
              .select()
              .from(AssignmentTable)
              .where(
                and(
                  eq(AssignmentTable.source_type, "delegation"),
                  eq(AssignmentTable.session_id, task.session_id),
                  eq(AssignmentTable.source_session_id, SessionID.make(source.sessionID)),
                  eq(AssignmentTable.source_run_id, source.runID),
                  eq(AssignmentTable.source_action_id, source.actionID),
                ),
              )
              .limit(2)
              .all()
          : []
    if (assignments.length > 1) throw new Conflict("task_migration_assignment_ambiguous")
    const assignment = assignments[0]
    const bodyref = assignment?.content_ref ?? spec
    const bodyhash = assignment?.content_hash ?? revision.body_hash
    const size = new TextEncoder().encode(revision.body).byteLength
    const key = `task.migrate:${task.id}:${revision.id}`
    const command = tx.select().from(TaskCommandTable).where(eq(TaskCommandTable.idempotency_key, key)).limit(1).get()
    if (command && (command.task_id !== task.id || command.kind !== "task.migrate"))
      throw new Conflict("task_migration_command_drift")
    const events = tx
      .select()
      .from(TaskEventTable)
      .where(
        and(
          eq(TaskEventTable.task_id, task.id),
          eq(TaskEventTable.revision_id, revision.id),
          eq(TaskEventTable.type, "task.migrated"),
        ),
      )
      .limit(2)
      .all()
    if (events.length > 1) throw new Conflict("task_migration_event_ambiguous")
    if (events[0] && !command) throw new Conflict("task_migration_event_command_missing")
    const meta = events[0] ? baselineEvent(events[0], task, revision, command!.id) : undefined
    const prior = task.requirement_id ? requirement(tx, task.id, task.requirement_id) : undefined
    const pointed = revision.requirement_id ? requirement(tx, task.id, revision.requirement_id) : undefined
    if ((task.requirement_id && !prior) || (revision.requirement_id && !pointed))
      throw new Conflict("task_migration_requirement_missing")
    const highest =
      tx
        .select({ value: max(TaskRequirementTable.version) })
        .from(TaskRequirementTable)
        .where(eq(TaskRequirementTable.task_id, task.id))
        .get()?.value ?? 0
    const picked = candidate(tx, task.id, prior, pointed, highest, bodyref, bodyhash)
    if (picked.row && meta && picked.row.id !== meta.requirement)
      throw new Conflict("task_migration_event_requirement_drift")
    const specs = tx
      .select()
      .from(TaskResourceTable)
      .where(
        and(
          eq(TaskResourceTable.task_id, task.id),
          eq(TaskResourceTable.revision_id, revision.id),
          eq(TaskResourceTable.kind, "spec"),
        ),
      )
      .limit(2)
      .all()
    if (specs.length > 1) throw new Conflict("task_migration_resource_ambiguous")
    const indexed = specs[0]
    if (
      indexed &&
      (indexed.uri !== spec ||
        indexed.hash !== revision.body_hash ||
        indexed.size !== size ||
        indexed.visibility !== "task" ||
        indexed.lifecycle !== "active")
    )
      throw new Conflict("task_migration_resource_drift")
    const created = tx
      .select({ id: TaskEventTable.id })
      .from(TaskEventTable)
      .where(and(eq(TaskEventTable.task_id, task.id), eq(TaskEventTable.type, "task.created")))
      .limit(1)
      .get()
    const complete =
      picked.row &&
      prior?.id === picked.row.id &&
      pointed?.id === picked.row.id &&
      task.requirement_id === picked.row.id &&
      revision.requirement_id === picked.row.id &&
      revision.spec_ref === spec &&
      (!revision.plan_ref || revision.plan_ref === assignment?.content_ref) &&
      !!indexed
    if (picked.row) chain(tx, task.id, picked.row)
    if (!picked.row && picked.previous) chain(tx, task.id, picked.previous)
    if (!command && !events[0] && created && complete) return { replay: true as const }
    const tail =
      tx
        .select({ value: max(TaskEventTable.seq) })
        .from(TaskEventTable)
        .where(eq(TaskEventTable.task_id, task.id))
        .get()?.value ?? 0
    if (tail !== task.last_event_seq) throw new Conflict("task_migration_event_sequence_invalid")
    if (command?.status === "applied") {
      if (
        command.result_ref !== `task://${task.id}/revision/${revision.id}/migration-baseline` ||
        !events[0] ||
        !complete ||
        meta?.requirement !== picked.row?.id ||
        meta.resource !== indexed?.id
      )
        throw new Conflict("task_migration_applied_drift")
      return { replay: true as const }
    }
    if (command?.status === "rejected" || command?.result_ref) throw new Conflict("task_migration_command_drift")
    const id = picked.row?.id ?? meta?.requirement ?? `requirement_${randomUUID()}`
    const saved =
      picked.row ??
      Requirement.parse(
        tx
          .insert(TaskRequirementTable)
          .values({
            id,
            task_id: task.id,
            version: picked.version,
            source_refs: refs(task, revision, assignment),
            body_ref: bodyref,
            body_hash: bodyhash,
            constraints: {},
            acceptance: [],
            created_by: "migration",
            confirmed_at: null,
            supersedes_id: picked.previous?.id ?? null,
            time_created: revision.time_created,
          })
          .returning()
          .get(),
      )
    const resource = indexed
      ? Resource.parse(specs[0])
      : Resource.parse(
        tx
          .insert(TaskResourceTable)
          .values({
            id: meta?.resource ?? `resource_${randomUUID()}`,
            task_id: task.id,
            revision_id: revision.id,
            kind: "spec",
            uri: spec,
            hash: revision.body_hash,
            size,
            producer_type: "migration",
            producer_id: revision.id,
            summary: null,
            visibility: "task",
            lifecycle: "active",
            time_created: revision.time_created,
          })
          .returning()
          .get(),
      )
    if (meta && (meta.requirement !== saved.id || meta.resource !== resource.id))
      throw new Conflict("task_migration_event_reference_drift")
    tx.update(SessionTaskTable).set({ requirement_id: saved.id }).where(eq(SessionTaskTable.id, task.id)).run()
    tx.update(TaskRevisionTable)
      .set({ requirement_id: saved.id, spec_ref: spec })
      .where(and(eq(TaskRevisionTable.task_id, task.id), eq(TaskRevisionTable.id, revision.id)))
      .run()
    const claimed = command ?? claim(tx, { task_id: task.id, kind: "task.migrate", idempotency_key: key })
    const migrated = events[0]
      ? [Event.parse(events[0])]
      : append(tx, task.id, [
          {
            type: "task.migrated",
            revision_id: revision.id,
            command_id: claimed.id,
            data: {
              baseline: "current_snapshot",
              requirement_id: saved.id,
              source_type: task.source_type,
              revision_version: revision.version,
            },
            resource_refs: [resource.id],
          },
        ])
    return {
      command: apply(tx, claimed.id, `task://${task.id}/revision/${revision.id}/migration-baseline`),
      events: migrated,
      requirement: saved,
      resources: [resource],
      replay: false as const,
    }
  }

  function requirement(tx: Database.Transaction, taskID: string, id: string) {
    return tx
      .select()
      .from(TaskRequirementTable)
      .where(and(eq(TaskRequirementTable.task_id, taskID), eq(TaskRequirementTable.id, id)))
      .limit(1)
      .get()
  }

  function candidate(
    tx: Database.Transaction,
    taskID: string,
    prior: typeof TaskRequirementTable.$inferSelect | undefined,
    pointed: typeof TaskRequirementTable.$inferSelect | undefined,
    highest: number,
    bodyref: string,
    bodyhash: string,
  ) {
    if (pointed) {
      if (prior?.id !== pointed.id && pointed.version !== highest)
        throw new Conflict("task_migration_requirement_not_latest")
      if (prior && prior.id !== pointed.id && (pointed.version !== prior.version + 1 || pointed.supersedes_id !== prior.id))
        throw new Conflict("task_migration_requirement_chain_invalid")
      if (pointed.body_ref !== bodyref || pointed.body_hash !== bodyhash)
        throw new Conflict("task_migration_requirement_drift")
      return { row: pointed, previous: prior?.id === pointed.id ? undefined : prior, version: pointed.version }
    }
    if (prior && highest === prior.version && prior.body_ref === bodyref && prior.body_hash === bodyhash)
      return { row: prior, previous: undefined, version: prior.version }
    if (prior && highest !== prior.version && highest !== prior.version + 1)
      throw new Conflict("task_migration_requirement_chain_invalid")
    const version = prior ? prior.version + 1 : highest || 1
    const rows =
      highest === (prior?.version ?? 0)
        ? []
        : tx
            .select()
            .from(TaskRequirementTable)
            .where(
              and(
                eq(TaskRequirementTable.task_id, taskID),
                eq(TaskRequirementTable.version, version),
                eq(TaskRequirementTable.body_ref, bodyref),
                eq(TaskRequirementTable.body_hash, bodyhash),
              ),
            )
            .limit(2)
            .all()
    if (rows.length > 1) throw new Conflict("task_migration_requirement_ambiguous")
    if (highest && !prior && !rows[0]) throw new Conflict("task_migration_requirement_chain_invalid")
    if (prior && highest !== prior.version && !rows[0])
      throw new Conflict("task_migration_requirement_chain_invalid")
    if (rows[0] && prior && (rows[0].supersedes_id !== prior.id || rows[0].version !== prior.version + 1))
      throw new Conflict("task_migration_requirement_chain_invalid")
    return { row: rows[0], previous: prior, version: rows[0]?.version ?? version }
  }

  function chain(tx: Database.Transaction, taskID: string, input: typeof TaskRequirementTable.$inferSelect) {
    const result = lineage(tx, taskID, input)
    if (result?.valid === 1) return
    throw new Conflict(
      input.version > 10_000 && result?.depth === 10_000
        ? "task_migration_requirement_chain_too_deep"
        : "task_migration_requirement_chain_invalid",
    )
  }

  function lineage(tx: Database.Transaction, taskID: string, input: typeof TaskRequirementTable.$inferSelect) {
    return tx.get<{ valid: number; depth: number; terminal: number }>(sql`
      WITH RECURSIVE lineage(id, version, supersedes_id, depth) AS (
        SELECT id, version, supersedes_id, 1
        FROM task_requirement
        WHERE task_id = ${taskID}
          AND id = ${input.id}
          AND version = ${input.version}
        UNION ALL
        SELECT prior.id, prior.version, prior.supersedes_id, lineage.depth + 1
        FROM lineage
        JOIN task_requirement AS prior
          ON prior.task_id = ${taskID}
          AND prior.id = lineage.supersedes_id
          AND prior.version = lineage.version - 1
        WHERE lineage.depth < 10000
      )
      SELECT
        CASE
          WHEN COUNT(*) = ${input.version}
            AND MAX(depth) = ${input.version}
            AND MIN(version) = 1
            AND MAX(version) = ${input.version}
            AND SUM(CASE WHEN version = 1 AND supersedes_id IS NULL THEN 1 ELSE 0 END) = 1
          THEN 1
          ELSE 0
        END AS valid,
        COUNT(*) AS depth,
        COALESCE(MIN(version), 0) AS terminal
      FROM lineage
    `)
  }

  function baselineEvent(
    event: typeof TaskEventTable.$inferSelect,
    task: typeof SessionTaskTable.$inferSelect,
    revision: typeof TaskRevisionTable.$inferSelect,
    commandID: string,
  ) {
    const item = Event.parse(event)
    const data = item.data
    const keys = Object.keys(data).sort()
    const stable = ["baseline", "requirement_id", "revision_version", "source_type"]
    const legacy = [...stable, "revision_status", "task_status"].sort()
    const old = JSON.stringify(keys) === JSON.stringify(legacy)
    if (
      item.command_id !== commandID ||
      item.revision_id !== revision.id ||
      item.resource_refs.length !== 1 ||
      !item.resource_refs[0]?.startsWith("resource_") ||
      data.baseline !== "current_snapshot" ||
      typeof data.requirement_id !== "string" ||
      !data.requirement_id.startsWith("requirement_") ||
      data.source_type !== task.source_type ||
      data.revision_version !== revision.version ||
      (JSON.stringify(keys) !== JSON.stringify(stable) && !old) ||
      (old &&
        (!["running", "waiting_user", "revising", "blocked", "completed", "failed"].includes(
          String(data.task_status),
        ) ||
          !["draft", "active", "completed", "failed", "archived"].includes(String(data.revision_status))))
    )
      throw new Conflict("task_migration_event_drift")
    return { requirement: data.requirement_id, resource: item.resource_refs[0] }
  }

  function refs(
    task: typeof SessionTaskTable.$inferSelect,
    revision: typeof TaskRevisionTable.$inferSelect,
    assignment?: typeof AssignmentTable.$inferSelect,
  ) {
    const source = task.source_ref
    const values = [
      ["assignment", assignment?.id],
      ["session", assignment?.source_session_id],
      ["message", assignment?.source_message_id],
      ["run", assignment?.source_run_id],
      ["action", assignment?.source_action_id],
      ["message", revision.source_message_id],
      ["session", source.sessionID],
      ["message", source.messageID],
      ["run", source.runID],
      ["action", source.actionID],
      ["handoff", source.handoffID],
      ["session", source.sourceSessionID],
    ]
    return [
      ...new Set(
        values.flatMap(([kind, value]) => (typeof value === "string" && value ? [`${kind}:${value}`] : [])),
      ),
    ]
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

  export const audit = TaskLedgerAudit.audit

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
