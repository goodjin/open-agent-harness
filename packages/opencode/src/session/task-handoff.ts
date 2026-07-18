import { randomUUID } from "crypto"
import { Instance } from "@/project/instance"
import { ModelID, ProviderID } from "@/provider/schema"
import { and, Database, eq, inArray } from "@/storage/db"
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

  export async function get(id: string) {
    return Database.use((tx) => tx.select().from(TaskHandoffTable).where(eq(TaskHandoffTable.id, id)).get())
  }

  export async function propose(input: {
    sourceID: SessionID
    messageID: MessageID
    title: string
    body: string
    contextRefs: string[]
  }) {
    const title = input.title.trim()
    if (!title) throw new Conflict("task_handoff_title_required")
    const digest = hash(JSON.stringify([input.sourceID, input.messageID, title, input.body, input.contextRefs]))
    const key = `task_handoff_proposal:${input.sourceID}:${input.messageID}:${digest}`
    const now = Date.now()
    const row = Database.transaction(
      (tx) => {
        const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, input.sourceID)).get()
        if (!task) throw new Conflict("task_handoff_requires_bound_source")
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
            found.source_task_id !== task.id ||
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
            source_task_id: task.id,
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

  export async function confirm(id: string, input?: { assignmentID: string }) {
    const proof = input ? await SessionAssignment.get(input.assignmentID) : undefined
    const content = proof ? await SessionAssignment.content(proof.id) : undefined
    const plan = object(content)
    const route = object(plan.assignment)
    const expected = input ? await get(id) : undefined
    if (
      input &&
      (!proof || !expected || plan.plan !== expected.body || route.op !== "handoff" || route.target !== "peer")
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
        if (current.status === "started" || current.status === "confirmed" || current.status === "creating")
          return current
        if (current.status !== "proposed" && current.status !== "failed")
          throw new Conflict("task_handoff_not_confirmable")
        const assignment = input
          ? tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, input.assignmentID)).get()
          : undefined
        if (
          input &&
          (!assignment ||
            assignment.status !== "running" ||
            assignment.source_type !== "confirm" ||
            assignment.session_id !== current.source_session_id ||
            assignment.source_session_id !== current.source_session_id ||
            assignment.source_message_id !== current.source_message_id ||
            assignment.target !== "peer" ||
            assignment.title !== current.title ||
            assignment.content_ref !== proof?.content_ref ||
            assignment.content_hash !== proof?.content_hash ||
            assignment.content_version !== proof?.content_version)
        )
          throw new Conflict("task_handoff_confirmation_invalid")

        const target = current.target_session_id
          ? tx.select().from(SessionTable).where(eq(SessionTable.id, current.target_session_id)).get()
          : undefined
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
        if (found)
          tx.update(SessionEventOutboxTable)
            .set({ status: "pending", payload, updated_at: now, error: null })
            .where(eq(SessionEventOutboxTable.id, found.id))
            .run()
        else
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
        if (assignment) {
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
    const row = Database.use((tx) =>
      tx
        .update(TaskHandoffTable)
        .set({ status: "cancelled", error: null, time_completed: Date.now() })
        .where(and(eq(TaskHandoffTable.id, id), eq(TaskHandoffTable.status, "proposed")))
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
    return start(handoff, row)
  }

  export async function scan() {
    const rows = Database.use((tx) =>
      tx
        .select({ id: TaskHandoffTable.id })
        .from(TaskHandoffTable)
        .innerJoin(SessionTable, eq(SessionTable.id, TaskHandoffTable.source_session_id))
        .where(
          and(
            inArray(TaskHandoffTable.status, ["confirmed", "creating", "failed"]),
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
          ),
        )
        .all(),
    )
    return Promise.all(
      rows.map((row) =>
        resume(row.id).catch((err) => {
          log.warn("task handoff recovery blocked", { err, handoffID: row.id })
          return false
        }),
      ),
    )
  }

  async function start(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect): Promise<boolean> {
    const data = row.payload
    const target = typeof data.target_session_id === "string" ? SessionID.make(data.target_session_id) : undefined
    const task = typeof data.target_task_id === "string" ? data.target_task_id : undefined
    const revision = typeof data.target_revision_id === "string" ? data.target_revision_id : undefined
    const message = typeof data.message_id === "string" ? MessageID.make(data.message_id) : undefined
    if (!target || !task || !revision || !message) throw new Conflict("task_handoff_outbox_invalid")
    if (
      target !== handoff.target_session_id ||
      task !== handoff.target_task_id ||
      row.target_session_id !== target ||
      row.session_id !== handoff.source_session_id
    )
      throw new Conflict("task_handoff_outbox_scope_invalid")
    const owner = Database.use((tx) =>
      tx
        .select({ task: SessionTaskTable.id })
        .from(SessionTaskTable)
        .innerJoin(
          TaskRevisionTable,
          and(
            eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id),
            eq(TaskRevisionTable.task_id, SessionTaskTable.id),
          ),
        )
        .where(
          and(
            eq(SessionTaskTable.id, task),
            eq(SessionTaskTable.session_id, target),
            eq(SessionTaskTable.current_revision_id, revision),
            eq(TaskRevisionTable.status, "active"),
          ),
        )
        .get(),
    )
    if (!owner) throw new Conflict("task_handoff_target_invalid")
    const now = Date.now()
    const existing = await MessageV2.get({ sessionID: target, messageID: message }).catch(() => undefined)
    if (row.status === "delivered" || row.status === "acked") {
      await complete(handoff, row)
      return true
    }
    if (row.status === "delivering") {
      if (row.updated_at > now - 30_000) return true
      if (existing) {
        const stamp = Date.now()
        const claimed = Database.use((tx) =>
          tx
            .update(SessionEventOutboxTable)
            .set({ updated_at: stamp })
            .where(
              and(
                eq(SessionEventOutboxTable.id, row.id),
                eq(SessionEventOutboxTable.payload, row.payload),
                eq(SessionEventOutboxTable.status, "delivering"),
                eq(SessionEventOutboxTable.updated_at, row.updated_at),
              ),
            )
            .returning({ id: SessionEventOutboxTable.id })
            .get(),
        )
        if (!claimed) return true
        await launch(target, message)
        await deliver(handoff, row, stamp)
        return true
      }
      const reset = Database.use((tx) =>
        tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", updated_at: now })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              eq(SessionEventOutboxTable.payload, row.payload),
              eq(SessionEventOutboxTable.status, "delivering"),
              eq(SessionEventOutboxTable.updated_at, row.updated_at),
            ),
          )
          .returning()
          .get(),
      )
      return reset ? start(handoff, reset) : true
    }
    if (row.status !== "pending" && row.status !== "failed") return true
    const stamp = Date.now()
    const claimed = Database.use((tx) =>
      tx
        .update(SessionEventOutboxTable)
        .set({ status: "delivering", updated_at: stamp, error: null })
        .where(
          and(
            eq(SessionEventOutboxTable.id, row.id),
            eq(SessionEventOutboxTable.payload, row.payload),
            eq(SessionEventOutboxTable.status, row.status),
            eq(SessionEventOutboxTable.updated_at, row.updated_at),
          ),
        )
        .returning()
        .get(),
    )
    if (!claimed) return true
    const session = await Session.get(target)
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
    }).catch((err) => {
      fail(handoff, row, stamp, err)
      throw err
    })
    await launch(target, message)
    await deliver(handoff, row, stamp)
    return true
  }

  async function launch(sessionID: SessionID, messageID: MessageID) {
    if (SessionPrompt.busy(sessionID)) return
    const messages = await Session.messages({ sessionID, limit: 20 })
    if (messages.some((item) => item.info.role === "assistant" && item.info.parentID === messageID)) return
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
          .where(and(eq(TaskHandoffTable.id, handoff.id), eq(TaskHandoffTable.status, "creating")))
          .run()
      },
      { behavior: "immediate" },
    )
  }

  async function deliver(handoff: Info, row: typeof SessionEventOutboxTable.$inferSelect, stamp: number) {
    const delivered = Database.transaction(
      (tx) => {
        const now = Date.now()
        const sent = tx
          .update(SessionEventOutboxTable)
          .set({ status: "delivered", delivered_at: now, acked_at: null, updated_at: now, error: null })
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
        if (!sent) return false
        tx.update(TaskHandoffTable)
          .set({ status: "started", error: null, time_completed: now })
          .where(and(eq(TaskHandoffTable.id, handoff.id), inArray(TaskHandoffTable.status, ["creating", "failed"])))
          .run()
        return true
      },
      { behavior: "immediate" },
    )
    if (!delivered) return
    const saved = await get(handoff.id)
    if (saved) await project(saved, "task_handoff_started")
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
    if (saved) await project(saved, "task_handoff_started")
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
        title: row.title,
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

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }
}
