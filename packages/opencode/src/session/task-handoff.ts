import { randomUUID } from "crypto"
import { Instance } from "@/project/instance"
import { ModelID, ProviderID } from "@/provider/schema"
import { and, Database, eq, exists, inArray, isNull, or, sql } from "@/storage/db"
import { Log } from "@/util/log"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { MessageID, PartID, SessionID } from "./schema"
import {
  MessageTable,
  AssignmentTable,
  SessionEventOutboxTable,
  SessionTable,
  SessionTaskTable,
  TaskHandoffTable,
  TaskRevisionTable,
} from "./session.sql"
import { SessionTask } from "./task"
import { TaskDocuments } from "./task-documents"
import { SessionAssignment } from "./assignment"

export namespace SessionTaskHandoff {
  const log = Log.create({ service: "session.task-handoff" })

  export class Conflict extends Error {
    constructor(message = "task_handoff_conflict") {
      super(message)
      this.name = "TaskHandoffConflict"
    }
  }

  export type Info = typeof TaskHandoffTable.$inferSelect

  export function summaries(input: { tasks?: string[]; sessionID?: SessionID }) {
    if (!input.tasks?.length && !input.sessionID) return []
    const tasks = input.tasks ?? []
    const task = tasks.length
      ? or(inArray(TaskHandoffTable.source_task_id, tasks), inArray(TaskHandoffTable.target_task_id, tasks))
      : undefined
    const session = input.sessionID
      ? or(
          eq(TaskHandoffTable.source_session_id, input.sessionID),
          eq(TaskHandoffTable.target_session_id, input.sessionID),
        )
      : undefined
    const where = task && session ? and(task, session) : (task ?? session)
    if (!where) return []
    return Database.use((db) =>
      db
        .select()
        .from(TaskHandoffTable)
        .where(where)
        .orderBy(TaskHandoffTable.time_created)
        .all()
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          source_session_id: item.source_session_id,
          ...(item.source_task_id === null ? {} : { source_task_id: item.source_task_id }),
          ...(item.target_session_id === null ? {} : { target_session_id: item.target_session_id }),
          ...(item.target_task_id === null ? {} : { target_task_id: item.target_task_id }),
          ...(item.error === null ? {} : { error: item.error }),
          time: {
            created: item.time_created,
            ...(item.time_confirmed === null ? {} : { confirmed: item.time_confirmed }),
            ...(item.time_completed === null ? {} : { completed: item.time_completed }),
          },
        })),
    )
  }

  export async function get(id: string) {
    return Database.use(
      (tx) =>
        tx
          .select({ handoff: TaskHandoffTable })
          .from(TaskHandoffTable)
          .innerJoin(SessionTable, eq(SessionTable.id, TaskHandoffTable.source_session_id))
          .where(
            and(
              eq(TaskHandoffTable.id, id),
              eq(SessionTable.project_id, Instance.project.id),
              eq(SessionTable.directory, Instance.directory),
            ),
          )
          .get()?.handoff,
    )
  }

  export function locate(input: {
    sourceID: SessionID
    messageID: MessageID
    runID: string
    actionID: string
    title: string
    body: string
  }) {
    return Database.use((db) =>
      db
        .select()
        .from(TaskHandoffTable)
        .where(
          and(
            eq(TaskHandoffTable.source_session_id, input.sourceID),
            eq(TaskHandoffTable.source_message_id, input.messageID),
          ),
        )
        .all()
        .find(
          (row) =>
            row.dedupe_key ===
            dedupe({
              sourceID: input.sourceID,
              messageID: input.messageID,
              runID: input.runID,
              actionID: input.actionID,
              title: input.title,
              body: input.body,
              contextRefs: row.context_refs,
            }),
        ),
    )
  }

  export async function propose(input: {
    sourceID: SessionID
    messageID: MessageID
    runID: string
    actionID: string
    title: string
    body: string
    contextRefs: string[]
  }) {
    const title = input.title.trim()
    if (!title) throw new Conflict("task_handoff_title_required")
    if (!input.runID || !input.actionID) throw new Conflict("task_handoff_source_invalid")
    const key = dedupe({ ...input, title })
    const now = Date.now()
    const row = Database.transaction(
      (tx) => {
        const owner = tx
          .select({ task: SessionTaskTable })
          .from(SessionTaskTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionTaskTable.session_id))
          .where(
            and(
              eq(SessionTaskTable.session_id, input.sourceID),
              eq(SessionTable.project_id, Instance.project.id),
              eq(SessionTable.directory, Instance.directory),
            ),
          )
          .get()
        if (!owner) throw new Conflict("task_handoff_requires_bound_source")
        const message = tx
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sourceID)))
          .get()
        if (!message) throw new Conflict("task_handoff_source_message_invalid")
        const found = tx.select().from(TaskHandoffTable).where(eq(TaskHandoffTable.dedupe_key, key)).get()
        if (found) {
          if (
            found.source_session_id !== input.sourceID ||
            found.source_message_id !== input.messageID ||
            found.source_task_id !== owner.task.id ||
            found.title !== title ||
            found.body !== input.body ||
            JSON.stringify(found.context_refs) !== JSON.stringify(input.contextRefs)
          )
            throw new Conflict("task_handoff_dedupe_conflict")
          return found
        }
        return tx
          .insert(TaskHandoffTable)
          .values({
            id: `handoff_${randomUUID()}`,
            source_session_id: input.sourceID,
            source_task_id: owner.task.id,
            source_message_id: input.messageID,
            target_session_id: null,
            target_task_id: null,
            title,
            body: input.body,
            body_hash: hash(input.body),
            context_refs: input.contextRefs,
            status: "proposed",
            dedupe_key: key,
            error: null,
            time_created: now,
            time_confirmed: null,
            time_completed: null,
          })
          .returning()
          .get()
      },
      { behavior: "immediate" },
    )
    await project(row, "task_handoff_proposal")
    return row
  }

  export async function confirm(id: string, input: { assignmentID: string }) {
    if (!input?.assignmentID) throw new Conflict("task_handoff_confirmation_required")
    const expected = await get(id)
    if (!expected) throw new Conflict("task_handoff_not_found")
    const proof = await SessionAssignment.get(input.assignmentID)
    const content = proof ? await SessionAssignment.content(proof.id) : undefined
    const plan = object(content)
    const route = object(plan.assignment)
    if (
      !proof ||
      plan.plan !== expected.body ||
      route.op !== "handoff" ||
      route.target !== "peer" ||
      expected.body_hash !== hash(expected.body)
    )
      throw new Conflict("task_handoff_confirmation_invalid")
    const now = Date.now()
    const row = Database.transaction(
      (tx) => {
        const current = tx.select().from(TaskHandoffTable).where(eq(TaskHandoffTable.id, id)).get()
        if (!current) throw new Conflict("task_handoff_not_found")
        const source = tx
          .select({ session: SessionTable, task: SessionTaskTable })
          .from(SessionTaskTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionTaskTable.session_id))
          .where(
            and(
              eq(SessionTaskTable.id, current.source_task_id ?? ""),
              eq(SessionTaskTable.session_id, current.source_session_id),
              eq(SessionTable.project_id, Instance.project.id),
              eq(SessionTable.directory, Instance.directory),
            ),
          )
          .get()
        if (!source) throw new Conflict("task_handoff_source_invalid")
        const message = current.source_message_id
          ? tx
              .select({ id: MessageTable.id })
              .from(MessageTable)
              .where(
                and(
                  eq(MessageTable.id, current.source_message_id),
                  eq(MessageTable.session_id, current.source_session_id),
                ),
              )
              .get()
          : undefined
        if (!message) throw new Conflict("task_handoff_source_message_invalid")
        const assignment = tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, input.assignmentID)).get()
        const replay = current.status === "started" || current.status === "confirmed" || current.status === "creating"
        const retry = current.status === "failed"
        if (
          !assignment ||
          assignment.status !== (replay || retry ? "completed" : "running") ||
          assignment.source_type !== "confirm" ||
          assignment.session_id !== current.source_session_id ||
          assignment.source_session_id !== current.source_session_id ||
          assignment.source_message_id !== current.source_message_id ||
          !assignment.source_message_id ||
          !assignment.source_run_id ||
          !assignment.source_action_id ||
          current.dedupe_key !==
            dedupe({
              sourceID: current.source_session_id,
              messageID: assignment.source_message_id,
              runID: assignment.source_run_id,
              actionID: assignment.source_action_id,
              title: current.title,
              body: current.body,
              contextRefs: current.context_refs,
            }) ||
          assignment.target !== "peer" ||
          assignment.title !== current.title ||
          assignment.content_ref !== proof.content_ref ||
          assignment.content_hash !== proof.content_hash ||
          assignment.content_version !== proof.content_version
        )
          throw new Conflict("task_handoff_confirmation_invalid")
        if (replay) return current
        if (current.status !== "proposed" && current.status !== "failed")
          throw new Conflict("task_handoff_not_confirmable")

        const parent = source.session.parent_id
          ? tx
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(
                and(
                  eq(SessionTable.id, source.session.parent_id),
                  eq(SessionTable.project_id, Instance.project.id),
                  eq(SessionTable.directory, Instance.directory),
                ),
              )
              .get()
          : undefined
        if (source.session.parent_id && !parent) throw new Conflict("task_handoff_parent_invalid")

        const target = current.target_session_id
          ? tx
              .select()
              .from(SessionTable)
              .where(
                and(
                  eq(SessionTable.id, current.target_session_id),
                  eq(SessionTable.project_id, Instance.project.id),
                  eq(SessionTable.directory, Instance.directory),
                  source.session.parent_id
                    ? eq(SessionTable.parent_id, source.session.parent_id)
                    : isNull(SessionTable.parent_id),
                ),
              )
              .get()
          : undefined
        if (current.target_session_id && !target) throw new Conflict("task_handoff_target_invalid")
        const session = target
          ? Session.fromRow(target)
          : Session.build({
              directory: source.session.directory,
              workspaceID: source.session.workspace_id ?? undefined,
              parentID: source.session.parent_id ?? undefined,
              title: current.title,
              agent: source.session.agent ?? undefined,
              model: source.session.model
                ? {
                    providerID: ProviderID.make(source.session.model.providerID),
                    modelID: ModelID.make(source.session.model.modelID),
                  }
                : undefined,
              permission: source.session.permission ?? undefined,
            })
        if (!target) Session.save(tx, session)
        const taskID = current.target_task_id ?? `task_${randomUUID()}`
        const revisionID = current.target_task_id
          ? tx
              .select({ id: TaskRevisionTable.id })
              .from(TaskRevisionTable)
              .where(eq(TaskRevisionTable.task_id, current.target_task_id))
              .get()?.id
          : `revision_${randomUUID()}`
        if (!revisionID) throw new Conflict("task_handoff_target_revision_missing")
        if (!current.target_task_id) {
          tx.insert(SessionTaskTable)
            .values({
              id: taskID,
              session_id: session.id,
              title: current.title,
              status: "running",
              current_revision_id: null,
              source_type: "handoff",
              source_ref: { handoffID: current.id, sourceSessionID: current.source_session_id },
              time_created: now,
              time_updated: now,
            })
            .run()
          tx.insert(TaskRevisionTable)
            .values({
              id: revisionID,
              task_id: taskID,
              version: 1,
              previous_id: null,
              status: "active",
              title: current.title,
              body: current.body,
              body_hash: current.body_hash,
              source_message_id: current.source_message_id,
              reason: "Confirmed task handoff",
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
          tx.update(SessionTaskTable)
            .set({ current_revision_id: revisionID })
            .where(eq(SessionTaskTable.id, taskID))
            .run()
        }
        const saved = tx
          .update(TaskHandoffTable)
          .set({
            target_session_id: session.id,
            target_task_id: taskID,
            status: "creating",
            error: null,
            time_confirmed: current.time_confirmed ?? now,
          })
          .where(and(eq(TaskHandoffTable.id, current.id), inArray(TaskHandoffTable.status, ["proposed", "failed"])))
          .returning()
          .get()
        if (!saved) return tx.select().from(TaskHandoffTable).where(eq(TaskHandoffTable.id, current.id)).get()!
        const key = `task_handoff:${current.id}`
        const found = tx.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.dedupe_key, key)).get()
        const payload = {
          handoff_id: current.id,
          source_session_id: current.source_session_id,
          target_session_id: session.id,
          target_task_id: taskID,
          target_revision_id: revisionID,
          message_id: found?.payload.message_id ?? MessageID.ascending(),
        }
        if (found) {
          const retry = found.status === "pending" || found.status === "failed"
          if (retry)
            tx.update(SessionEventOutboxTable)
              .set({ status: "pending", payload, updated_at: now, error: null })
              .where(
                and(
                  eq(SessionEventOutboxTable.id, found.id),
                  eq(SessionEventOutboxTable.payload, found.payload),
                  eq(SessionEventOutboxTable.status, found.status),
                  eq(SessionEventOutboxTable.updated_at, found.updated_at),
                ),
              )
              .run()
        } else
          tx.insert(SessionEventOutboxTable)
            .values({
              id: `outbox_${randomUUID()}`,
              session_id: current.source_session_id,
              target_session_id: session.id,
              kind: "task_handoff",
              dedupe_key: key,
              status: "pending",
              payload,
              created_at: now,
              updated_at: now,
              delivered_at: null,
              acked_at: null,
              error: null,
            })
            .run()
        if (assignment.status === "running") {
          const consumed = tx
            .update(AssignmentTable)
            .set({ status: "completed", time_updated: now })
            .where(and(eq(AssignmentTable.id, assignment.id), eq(AssignmentTable.status, "running")))
            .returning({ id: AssignmentTable.id })
            .get()
          if (!consumed) throw new Conflict("task_handoff_confirmation_invalid")
        }
        return saved
      },
      { behavior: "immediate" },
    )
    if (row.target_session_id) {
      const sessionID = row.target_session_id
      const target = await SessionTask.get(sessionID)
      if (target)
        Database.effect(() =>
          TaskDocuments.publish({
            sessionID,
            taskID: target.task.id,
            version: target.revision.version,
            title: target.revision.title,
            body: target.revision.body,
            current: true,
          }),
        )
    }
    Database.effect(() =>
      resume(row.id).catch((err) => log.warn("task handoff start blocked", { err, handoffID: row.id })),
    )
    return row
  }

  export async function cancel(id: string) {
    const current = await get(id)
    if (!current) return
    const row = Database.use((tx) =>
      tx
        .update(TaskHandoffTable)
        .set({ status: "cancelled", error: null, time_completed: Date.now() })
        .where(
          and(
            eq(TaskHandoffTable.id, current.id),
            eq(TaskHandoffTable.source_session_id, current.source_session_id),
            eq(TaskHandoffTable.status, "proposed"),
          ),
        )
        .returning()
        .get(),
    )
    return row ?? get(id)
  }

  export async function resume(id: string) {
    const handoff = await get(id)
    if (!handoff) return false
    const row = Database.use((tx) =>
      tx
        .select()
        .from(SessionEventOutboxTable)
        .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${id}`))
        .get(),
    )
    if (!row) return false
    if (row.kind !== "task_handoff") return false
    return start(handoff, row).catch((err) => {
      reject(handoff, row, err)
      throw err
    })
  }

  export async function scan() {
    const started = Date.now()
    const rows = Database.use((tx) =>
      tx
        .select({ id: TaskHandoffTable.id })
        .from(TaskHandoffTable)
        .innerJoin(SessionTable, eq(SessionTable.id, TaskHandoffTable.source_session_id))
        .innerJoin(
          SessionEventOutboxTable,
          and(
            eq(SessionEventOutboxTable.kind, "task_handoff"),
            sql`${SessionEventOutboxTable.dedupe_key} = ${"task_handoff:"} || ${TaskHandoffTable.id}`,
            eq(SessionEventOutboxTable.session_id, TaskHandoffTable.source_session_id),
            eq(SessionEventOutboxTable.target_session_id, TaskHandoffTable.target_session_id),
          ),
        )
        .where(
          and(
            or(
              inArray(TaskHandoffTable.status, ["confirmed", "creating", "failed"]),
              and(eq(TaskHandoffTable.status, "started"), eq(SessionEventOutboxTable.status, "delivered")),
            ),
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
          ),
        )
        .all(),
    )
    const results: boolean[] = []
    for (let index = 0; index < rows.length; index += 4) {
      const batch = await Promise.all(
        rows.slice(index, index + 4).map((row) =>
          resume(row.id).catch((err) => {
            log.warn("task handoff recovery blocked", { err, handoffID: row.id })
            return false
          }),
        ),
      )
      results.push(...batch)
    }
    log.info("task handoff recovery scan completed", { candidates: rows.length, duration: Date.now() - started })
    return results
  }

  function guard(
    tx: Database.TxOrDb,
    handoff: Info,
    row: typeof SessionEventOutboxTable.$inferSelect,
    status: typeof SessionEventOutboxTable.$inferSelect.status,
    updated?: number,
  ) {
    const data = row.payload
    const target = typeof data.target_session_id === "string" ? SessionID.make(data.target_session_id) : undefined
    const task = typeof data.target_task_id === "string" ? data.target_task_id : ""
    const revision = typeof data.target_revision_id === "string" ? data.target_revision_id : ""
    if (
      data.handoff_id !== handoff.id ||
      data.source_session_id !== handoff.source_session_id ||
      !target ||
      !task ||
      !revision
    )
      return
    const owner = tx
      .select({ id: TaskHandoffTable.id })
      .from(TaskHandoffTable)
      .innerJoin(SessionTable, eq(SessionTable.id, TaskHandoffTable.target_session_id))
      .innerJoin(
        SessionTaskTable,
        and(
          eq(SessionTaskTable.id, TaskHandoffTable.target_task_id),
          eq(SessionTaskTable.session_id, TaskHandoffTable.target_session_id),
        ),
      )
      .innerJoin(
        TaskRevisionTable,
        and(
          eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id),
          eq(TaskRevisionTable.task_id, SessionTaskTable.id),
        ),
      )
      .where(
        and(
          eq(TaskHandoffTable.id, handoff.id),
          eq(TaskHandoffTable.source_session_id, handoff.source_session_id),
          eq(TaskHandoffTable.target_session_id, target),
          eq(TaskHandoffTable.target_task_id, task),
          inArray(TaskHandoffTable.status, ["creating", "failed"]),
          eq(SessionTable.project_id, Instance.project.id),
          eq(SessionTable.directory, Instance.directory),
          eq(SessionTaskTable.current_revision_id, revision),
          eq(TaskRevisionTable.status, "active"),
        ),
      )
    return and(
      eq(SessionEventOutboxTable.id, row.id),
      eq(SessionEventOutboxTable.session_id, handoff.source_session_id),
      eq(SessionEventOutboxTable.target_session_id, target),
      eq(SessionEventOutboxTable.payload, row.payload),
      eq(SessionEventOutboxTable.status, status),
      updated === undefined ? undefined : eq(SessionEventOutboxTable.updated_at, updated),
      exists(owner),
    )
  }

  function valid(
    handoff: Info,
    row: typeof SessionEventOutboxTable.$inferSelect,
    status: typeof SessionEventOutboxTable.$inferSelect.status,
    updated?: number,
  ) {
    return Database.use((tx) => {
      const where = guard(tx, handoff, row, status, updated)
      if (!where) return false
      return !!tx.select({ id: SessionEventOutboxTable.id }).from(SessionEventOutboxTable).where(where).get()
    })
  }

  function changed(row: typeof SessionEventOutboxTable.$inferSelect) {
    return Database.use((tx) => {
      const current = tx
        .select({ status: SessionEventOutboxTable.status, updated: SessionEventOutboxTable.updated_at })
        .from(SessionEventOutboxTable)
        .where(and(eq(SessionEventOutboxTable.id, row.id), eq(SessionEventOutboxTable.payload, row.payload)))
        .get()
      return !!current && (current.status !== row.status || current.updated !== row.updated_at)
    })
  }

  async function start(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect): Promise<boolean> {
    const data = row.payload
    const target = typeof data.target_session_id === "string" ? SessionID.make(data.target_session_id) : undefined
    const task = typeof data.target_task_id === "string" ? data.target_task_id : undefined
    const revision = typeof data.target_revision_id === "string" ? data.target_revision_id : undefined
    const message = typeof data.message_id === "string" ? MessageID.make(data.message_id) : undefined
    if (!target || !task || !revision || !message) throw new Conflict("task_handoff_outbox_invalid")
    if (
      data.handoff_id !== handoff.id ||
      data.source_session_id !== handoff.source_session_id ||
      target !== handoff.target_session_id ||
      task !== handoff.target_task_id ||
      row.target_session_id !== target ||
      row.session_id !== handoff.source_session_id
    )
      throw new Conflict("task_handoff_outbox_scope_invalid")
    if (!valid(handoff, row, row.status, row.updated_at) && row.status !== "delivered" && row.status !== "acked") {
      if (changed(row)) return true
      throw new Conflict("task_handoff_target_invalid")
    }
    if (row.status === "delivered" || row.status === "acked") {
      await complete(handoff, row)
      return true
    }
    const now = Date.now()
    const existing = await MessageV2.get({ sessionID: target, messageID: message }).catch(() => undefined)
    if (!valid(handoff, row, row.status, row.updated_at)) {
      if (changed(row)) return true
      throw new Conflict("task_handoff_target_invalid")
    }
    if (row.status === "delivering") {
      if (row.updated_at > now - 30_000) return true
      if (existing) {
        const stamp = Date.now()
        const claimed = Database.use((tx) => {
          const where = guard(tx, handoff, row, "delivering", row.updated_at)
          if (!where) return
          return tx
            .update(SessionEventOutboxTable)
            .set({ updated_at: stamp })
            .where(where)
            .returning({ id: SessionEventOutboxTable.id })
            .get()
        })
        if (!claimed) return true
        return recover(handoff, row, target, message, stamp)
      }
      const reset = Database.use((tx) => {
        const where = guard(tx, handoff, row, "delivering", row.updated_at)
        if (!where) return
        return tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", updated_at: now })
          .where(where)
          .returning()
          .get()
      })
      return reset ? start(handoff, reset) : true
    }
    if (row.status !== "pending" && row.status !== "failed") return true
    const stamp = Date.now()
    const claimed = Database.use((tx) => {
      const where = guard(tx, handoff, row, row.status, row.updated_at)
      if (!where) return
      return tx
        .update(SessionEventOutboxTable)
        .set({ status: "delivering", updated_at: stamp, error: null })
        .where(where)
        .returning()
        .get()
    })
    if (!claimed) return true
    return dispatch(handoff, row, target, task, revision, message, stamp)
  }

  async function dispatch(
    handoff: Info,
    row: typeof SessionEventOutboxTable.$inferSelect,
    target: SessionID,
    task: string,
    revision: string,
    message: MessageID,
    stamp: number,
  ) {
    try {
      if (!valid(handoff, row, "delivering", stamp)) throw new Conflict("task_handoff_target_invalid")
      const session = await Session.get(target)
      if (!valid(handoff, row, "delivering", stamp)) throw new Conflict("task_handoff_target_invalid")
      await SessionPrompt.enqueue({
        sessionID: target,
        messageID: message,
        agent: session.agent,
        metadata: {
          internal: true,
          source: "task_handoff_bootstrap",
          handoff_id: handoff.id,
          task_id: task,
          revision_id: revision,
        },
        parts: [
          {
            type: "text",
            text: [
              "A confirmed Task handoff is ready in this session.",
              "Inspect the current Task and execute only its active revision.",
              "Return results in this session; do not continue the source session's task.",
            ].join("\n"),
          },
        ],
      })
      if (!valid(handoff, row, "delivering", stamp)) throw new Conflict("task_handoff_target_invalid")
      await launch(target, message)
      if (!valid(handoff, row, "delivering", stamp)) throw new Conflict("task_handoff_target_invalid")
      await deliver(handoff, row, stamp)
      return true
    } catch (err) {
      fail(handoff, row, stamp, err)
      throw err
    }
  }

  async function recover(
    handoff: Info,
    row: typeof SessionEventOutboxTable.$inferSelect,
    target: SessionID,
    message: MessageID,
    stamp: number,
  ) {
    try {
      if (!valid(handoff, row, "delivering", stamp)) throw new Conflict("task_handoff_target_invalid")
      await launch(target, message)
      if (!valid(handoff, row, "delivering", stamp)) throw new Conflict("task_handoff_target_invalid")
      await deliver(handoff, row, stamp)
      return true
    } catch (err) {
      fail(handoff, row, stamp, err)
      throw err
    }
  }

  async function launch(sessionID: SessionID, messageID: MessageID) {
    void SessionPrompt.loop({ sessionID, messageID }).catch((err) =>
      log.warn("task handoff target failed", { err, sessionID, messageID }),
    )
  }

  function fail(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect, stamp: number, err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    Database.transaction(
      (tx) => {
        const reset = tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", updated_at: Date.now(), error: message })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              eq(SessionEventOutboxTable.payload, row.payload),
              eq(SessionEventOutboxTable.status, "delivering"),
              eq(SessionEventOutboxTable.updated_at, stamp),
            ),
          )
          .returning({ id: SessionEventOutboxTable.id })
          .get()
        if (!reset) return
        tx.update(TaskHandoffTable)
          .set({ status: "failed", error: message })
          .where(and(eq(TaskHandoffTable.id, handoff.id), inArray(TaskHandoffTable.status, ["creating", "failed"])))
          .run()
      },
      { behavior: "immediate" },
    )
  }

  function reject(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect, err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    Database.transaction(
      (tx) => {
        const reset = tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", updated_at: Date.now(), error: message })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              eq(SessionEventOutboxTable.payload, row.payload),
              eq(SessionEventOutboxTable.status, row.status),
              eq(SessionEventOutboxTable.updated_at, row.updated_at),
            ),
          )
          .returning({ id: SessionEventOutboxTable.id })
          .get()
        if (!reset) return
        tx.update(TaskHandoffTable)
          .set({ status: "failed", error: message })
          .where(and(eq(TaskHandoffTable.id, handoff.id), inArray(TaskHandoffTable.status, ["creating", "failed"])))
          .run()
      },
      { behavior: "immediate" },
    )
  }

  async function deliver(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect, stamp: number) {
    const delivered = Database.transaction(
      (tx) => {
        const now = Date.now()
        const where = guard(tx, handoff, row, "delivering", stamp)
        if (!where) return false
        const sent = tx
          .update(SessionEventOutboxTable)
          .set({ status: "delivered", delivered_at: now, acked_at: null, updated_at: now, error: null })
          .where(where)
          .returning({ id: SessionEventOutboxTable.id })
          .get()
        if (!sent) return false
        tx.update(TaskHandoffTable)
          .set({ status: "started", error: null, time_completed: now })
          .where(and(eq(TaskHandoffTable.id, handoff.id), inArray(TaskHandoffTable.status, ["creating", "failed"])))
          .run()
        return true
      },
      { behavior: "immediate" },
    )
    if (!delivered) throw new Conflict("task_handoff_delivery_lost")
    const saved = await get(handoff.id)
    if (saved) {
      await project(saved, "task_handoff_started")
      ack(saved, row)
    }
  }

  async function complete(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect) {
    Database.use((tx) =>
      tx
        .update(TaskHandoffTable)
        .set({
          status: "started",
          error: null,
          time_completed: handoff.time_completed ?? row.delivered_at ?? Date.now(),
        })
        .where(and(eq(TaskHandoffTable.id, handoff.id), inArray(TaskHandoffTable.status, ["creating", "failed"])))
        .run(),
    )
    const saved = await get(handoff.id)
    if (saved) {
      await project(saved, "task_handoff_started")
      if (row.status === "delivered") ack(saved, row)
    }
  }

  function ack(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect) {
    const target = handoff.target_session_id
    if (!target) return
    const now = Date.now()
    Database.use((tx) =>
      tx
        .update(SessionEventOutboxTable)
        .set({ status: "acked", acked_at: now, updated_at: now })
        .where(
          and(
            eq(SessionEventOutboxTable.id, row.id),
            eq(SessionEventOutboxTable.session_id, handoff.source_session_id),
            eq(SessionEventOutboxTable.target_session_id, target),
            eq(SessionEventOutboxTable.payload, row.payload),
            eq(SessionEventOutboxTable.status, "delivered"),
          ),
        )
        .run(),
    )
  }

  async function project(row: Info, kind: "task_handoff_proposal" | "task_handoff_started") {
    if (!row.source_message_id) return
    const message = await MessageV2.get({ sessionID: row.source_session_id, messageID: row.source_message_id }).catch(
      () => undefined,
    )
    if (!message) return
    const prev = message.parts.find(
      (item) => item.type === "text" && item.metadata?.kind === kind && item.metadata.handoff_id === row.id,
    )
    const now = Date.now()
    await Session.updatePart({
      id: prev?.id ?? PartID.ascending(),
      messageID: row.source_message_id,
      sessionID: row.source_session_id,
      type: "text",
      text: kind === "task_handoff_started" ? "Task handoff started." : "Task handoff proposal",
      synthetic: true,
      ignored: true,
      metadata: {
        kind,
        handoff_id: row.id,
        ...(kind === "task_handoff_proposal" ? { title: row.title } : {}),
        status: row.status,
        target_session_id: row.target_session_id,
        target_task_id: row.target_task_id,
      },
      time: { start: prev?.type === "text" ? (prev.time?.start ?? now) : now, end: now },
    })
  }

  function hash(input: string) {
    return new Bun.CryptoHasher("sha256").update(input).digest("hex")
  }

  function dedupe(input: {
    sourceID: SessionID
    messageID: MessageID
    runID: string
    actionID: string
    title: string
    body: string
    contextRefs: string[]
  }) {
    const digest = hash(
      JSON.stringify([
        input.sourceID,
        input.messageID,
        input.runID,
        input.actionID,
        input.title,
        input.body,
        input.contextRefs,
      ]),
    )
    return `task_handoff_proposal:${input.sourceID}:${input.messageID}:${digest}`
  }

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }
}
