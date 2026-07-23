import { sql } from "drizzle-orm"
import { check, foreignKey, sqliteTable, text, integer, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { Snapshot } from "../snapshot"
import type { PermissionNext } from "../permission/next"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"
import { Timestamps } from "../storage/schema.sql"

type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">
type InfoData = Omit<MessageV2.Info, "id" | "sessionID">
type LogData = Record<string, unknown>
type ResultCarrier = "action_result" | "agent_protocol_output" | "fallback_summary" | "plain_text_result" | "synthetic"
type ResultStatus = "completed" | "partial" | "blocked" | "failed" | "waiting_user" | "terminal_reply"
type AssignmentStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "superseded"
type AssignmentSource = "confirm" | "delegation"
type AssignmentResult = "completed" | "partial" | "blocked" | "failed" | "waiting_user"
type StatusClass = "active" | "blocked" | "interrupted" | "terminal" | "archived"
type StatusSource = "runtime" | "recovery" | "user" | "system"
type OutboxStatus = "pending" | "delivering" | "delivered" | "acked" | "failed"
type OutboxKind = "parent_handoff" | "task_revision_bootstrap" | "task_handoff" | "task_confirmation"
type TaskStatus = "running" | "waiting_user" | "revising" | "blocked" | "completed" | "failed"
type TaskSource = "user" | "delegation" | "handoff" | "legacy"
type RevisionStatus = "draft" | "active" | "completed" | "failed" | "archived"
type RevisionTerminal = "completed" | "blocked" | "failed"
type RevisionResult = "completed" | "partial" | "failed"
type RevisionStop = "planned" | "applied"
type HandoffStatus = "proposed" | "confirmed" | "creating" | "started" | "failed" | "cancelled"
type RequirementCreator = "user" | "agent" | "migration"
type ResourceKind = "requirement" | "spec" | "plan"
type ResourceProducer = "requirement" | "revision" | "assignment" | "migration"
type ResourceVisibility = "private" | "task" | "project" | "exportable"
type ResourceLifecycle = "active" | "archived" | "tombstoned"
type CommandStatus = "accepted" | "applied" | "rejected"

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    title: text().notNull(),
    agent: text(),
    model: text({ mode: "json" }).$type<{ providerID: string; modelID: string }>(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<PermissionNext.Ruleset>(),
    dsl_context: text({ mode: "json" }).$type<Record<string, unknown>>(),
    status_class: text().$type<StatusClass>().notNull().default("active"),
    status: text().notNull().default("idle"),
    status_message: text(),
    status_recoverable: integer({ mode: "boolean" }).notNull().default(true),
    status_updated_at: integer().notNull().default(0),
    status_source: text().$type<StatusSource>().notNull().default("runtime"),
    status_detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const SessionLogTable = sqliteTable(
  "session_log",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<MessageID>(),
    part_id: text().$type<PartID>(),
    level: text().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).notNull().$type<LogData>(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("session_log_session_time_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_log_time_idx").on(table.time_created),
  ],
)

export const SessionResultTable = sqliteTable(
  "session_result",
  {
    id: text().primaryKey(),
    carrier: text().$type<ResultCarrier>().notNull(),
    status: text().$type<ResultStatus>().notNull(),
    satisfying: integer({ mode: "boolean" }).notNull(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text().$type<SessionID>(),
    child_session_id: text().$type<SessionID>(),
    run_id: text(),
    action_id: text(),
    target_action_id: text(),
    raw_ref: text().notNull(),
    summary: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("session_result_session_idx").on(table.session_id),
    index("session_result_parent_child_idx").on(table.parent_session_id, table.child_session_id),
    index("session_result_run_action_idx").on(table.run_id, table.action_id),
    uniqueIndex("session_result_parent_child_run_action_unique_idx").on(
      table.parent_session_id,
      table.child_session_id,
      table.run_id,
      table.action_id,
    ),
  ],
)

export const SessionEventOutboxTable = sqliteTable(
  "session_event_outbox",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    target_session_id: text().$type<SessionID>(),
    kind: text().$type<OutboxKind>().notNull(),
    dedupe_key: text().notNull(),
    status: text().$type<OutboxStatus>().notNull(),
    payload: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    delivered_at: integer(),
    acked_at: integer(),
    error: text(),
  },
  (table) => [
    index("session_event_outbox_session_idx").on(table.session_id),
    index("session_event_outbox_status_idx").on(table.status),
    uniqueIndex("session_event_outbox_dedupe_key_idx").on(table.dedupe_key),
  ],
)

export const AssignmentTable = sqliteTable(
  "assignment",
  {
    id: text().primaryKey(),
    parent_id: text(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source_type: text().$type<AssignmentSource>().notNull(),
    source_session_id: text().$type<SessionID>(),
    source_message_id: text().$type<MessageID>(),
    source_run_id: text(),
    source_action_id: text(),
    target: text().notNull(),
    title: text().notNull(),
    status: text().$type<AssignmentStatus>().notNull(),
    content_ref: text().notNull(),
    content_hash: text().notNull(),
    content_version: integer().notNull(),
    result_ref: text(),
    result_status: text().$type<AssignmentResult>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("assignment_session_status_idx").on(table.session_id, table.status),
    index("assignment_parent_idx").on(table.parent_id),
    uniqueIndex("assignment_source_unique_idx").on(
      table.source_session_id,
      table.source_run_id,
      table.source_action_id,
    ),
  ],
)

export const TaskConfirmationTable = sqliteTable(
  "task_confirmation",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    proposal_id: text().notNull(),
    operation: text().$type<"update" | "handoff">().notNull(),
    decision: text().$type<"confirm" | "cancel">().notNull(),
    status: text().$type<"claimed" | "continuation_pending" | "completed" | "cancelled" | "failed">().notNull(),
    expected_revision_id: text(),
    handoff_id: text(),
    assignment_id: text(),
    message_id: text().$type<MessageID>().notNull(),
    owner_token: text(),
    generation: integer().notNull().default(1),
    lease_until: integer().notNull(),
    snapshot: text({ mode: "json" }).$type<Record<string, unknown>>(),
    snapshot_hash: text(),
    result: text({ mode: "json" }).$type<Record<string, unknown>>(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("task_confirmation_session_proposal_unique_idx").on(table.session_id, table.proposal_id),
    index("task_confirmation_status_idx").on(table.status),
  ],
)

export const SessionTaskTable = sqliteTable(
  "session_task",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    status: text().$type<TaskStatus>().notNull(),
    current_revision_id: text(),
    requirement_id: text(),
    status_reason: text(),
    last_event_seq: integer().notNull().default(0),
    checkpoint_id: text(),
    schema_version: integer().notNull().default(1),
    source_type: text().$type<TaskSource>().notNull(),
    source_ref: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_task_session_unique_idx").on(table.session_id),
    uniqueIndex("session_task_session_id_unique_idx").on(table.session_id, table.id),
  ],
)

export const TaskRequirementTable = sqliteTable(
  "task_requirement",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    source_refs: text({ mode: "json" }).$type<string[]>().notNull(),
    body_ref: text().notNull(),
    body_hash: text().notNull(),
    constraints: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    acceptance: text({ mode: "json" }).$type<Record<string, unknown>[]>().notNull(),
    created_by: text().$type<RequirementCreator>().notNull(),
    confirmed_at: integer(),
    supersedes_id: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("task_requirement_task_version_unique_idx").on(table.task_id, table.version),
    uniqueIndex("task_requirement_task_id_unique_idx").on(table.task_id, table.id),
    index("task_requirement_task_created_idx").on(table.task_id, table.time_created),
    foreignKey({
      columns: [table.task_id, table.supersedes_id],
      foreignColumns: [table.task_id, table.id],
      name: "task_requirement_supersedes_fk",
    }),
    check("task_requirement_body_hash_check", sql`length(${table.body_hash}) = 64`),
  ],
)

export const TaskRevisionTable = sqliteTable(
  "task_revision",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    previous_id: text(),
    status: text().$type<RevisionStatus>().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    body_hash: text().notNull(),
    source_message_id: text().$type<MessageID>(),
    reason: text(),
    workflow: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text(),
    result_source: text(),
    time_created: integer().notNull(),
    time_activated: integer(),
    time_completed: integer(),
    time_archived: integer(),
    archive_reason: text(),
    terminal_status: text().$type<RevisionTerminal>(),
    stopped_child_count: integer(),
    result_status: text().$type<RevisionResult>(),
    requirement_id: text(),
    spec_ref: text(),
    design_ref: text(),
    plan_ref: text(),
    graph_id: text(),
    schema_version: integer().notNull().default(1),
  },
  (table) => [
    uniqueIndex("task_revision_task_version_unique_idx").on(table.task_id, table.version),
    uniqueIndex("task_revision_task_id_unique_idx").on(table.task_id, table.id),
    uniqueIndex("task_revision_one_active_idx")
      .on(table.task_id)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      columns: [table.task_id, table.previous_id],
      foreignColumns: [table.task_id, table.id],
      name: "task_revision_previous_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.task_id, table.requirement_id],
      foreignColumns: [TaskRequirementTable.task_id, TaskRequirementTable.id],
      name: "task_revision_requirement_fk",
    }),
  ],
)

export const TaskResourceTable = sqliteTable(
  "task_resource",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    revision_id: text(),
    kind: text().$type<ResourceKind>().notNull(),
    uri: text().notNull(),
    hash: text().notNull(),
    size: integer().notNull(),
    summary: text(),
    producer_type: text().$type<ResourceProducer>().notNull(),
    producer_id: text().notNull(),
    visibility: text().$type<ResourceVisibility>().notNull(),
    lifecycle: text().$type<ResourceLifecycle>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("task_resource_identity_unique_idx").on(table.task_id, table.kind, table.hash, table.uri),
    index("task_resource_revision_idx").on(table.revision_id),
    index("task_resource_task_kind_idx").on(table.task_id, table.kind),
    foreignKey({
      columns: [table.task_id, table.revision_id],
      foreignColumns: [TaskRevisionTable.task_id, TaskRevisionTable.id],
      name: "task_resource_revision_fk",
    }),
    check("task_resource_hash_check", sql`length(${table.hash}) = 64`),
    check("task_resource_size_check", sql`${table.size} >= 0`),
  ],
)

export const TaskCommandTable = sqliteTable(
  "task_command",
  {
    id: text().primaryKey(),
    task_id: text().references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    idempotency_key: text().notNull(),
    status: text().$type<CommandStatus>().notNull(),
    result_ref: text(),
    time_created: integer().notNull(),
    time_applied: integer(),
  },
  (table) => [
    uniqueIndex("task_command_idempotency_unique_idx").on(table.idempotency_key),
    uniqueIndex("task_command_task_id_unique_idx").on(table.task_id, table.id),
    index("task_command_task_created_idx").on(table.task_id, table.time_created),
  ],
)

export const TaskEventTable = sqliteTable(
  "task_event",
  {
    task_id: text()
      .notNull()
      .references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    id: text().notNull(),
    type: text().notNull(),
    revision_id: text(),
    command_id: text(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    resource_refs: text({ mode: "json" }).$type<string[]>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.seq] }),
    uniqueIndex("task_event_id_unique_idx").on(table.id),
    index("task_event_task_type_idx").on(table.task_id, table.type),
    index("task_event_revision_idx").on(table.revision_id),
    foreignKey({
      columns: [table.task_id, table.revision_id],
      foreignColumns: [TaskRevisionTable.task_id, TaskRevisionTable.id],
      name: "task_event_revision_fk",
    }),
    foreignKey({
      columns: [table.task_id, table.command_id],
      foreignColumns: [TaskCommandTable.task_id, TaskCommandTable.id],
      name: "task_event_command_fk",
    }),
  ],
)

export const TaskRevisionStopTable = sqliteTable(
  "task_revision_stop",
  {
    revision_id: text()
      .notNull()
      .references(() => TaskRevisionTable.id, { onDelete: "cascade" }),
    child_session_id: text().$type<SessionID>().notNull(),
    run_id: text().notNull(),
    action_id: text().notNull(),
    state: text().$type<RevisionStop>().notNull(),
    reason: text().notNull(),
    time_created: integer().notNull(),
    time_applied: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.revision_id, table.child_session_id] }),
    index("task_revision_stop_state_idx").on(table.revision_id, table.state),
  ],
)

export const TaskHandoffTable = sqliteTable(
  "task_handoff",
  {
    id: text().primaryKey(),
    source_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source_task_id: text().references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    source_message_id: text().$type<MessageID>(),
    target_session_id: text().$type<SessionID>(),
    target_task_id: text(),
    title: text().notNull(),
    body: text().notNull(),
    body_hash: text().notNull(),
    context_refs: text({ mode: "json" }).$type<string[]>().notNull(),
    status: text().$type<HandoffStatus>().notNull(),
    dedupe_key: text().notNull(),
    error: text(),
    time_created: integer().notNull(),
    time_confirmed: integer(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("task_handoff_dedupe_unique_idx").on(table.dedupe_key),
    index("task_handoff_source_task_idx").on(table.source_task_id),
    index("task_handoff_target_task_idx").on(table.target_task_id),
    foreignKey({
      columns: [table.source_session_id, table.source_task_id],
      foreignColumns: [SessionTaskTable.session_id, SessionTaskTable.id],
      name: "task_handoff_source_task_fk",
    }).onDelete("cascade"),
    check(
      "task_handoff_target_pair_check",
      sql`(${table.target_session_id} IS NULL) = (${table.target_task_id} IS NULL)`,
    ),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<PermissionNext.Ruleset>(),
})
