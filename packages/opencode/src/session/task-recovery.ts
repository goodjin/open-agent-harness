import { and, Database, eq, exists, inArray, or, sql } from "@/storage/db"
import { Session } from "."
import { SessionDelegation } from "./delegation"
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { SessionResult } from "./result"
import { MessageID, PartID, SessionID } from "./schema"
import {
  SessionEventOutboxTable,
  SessionTable,
  SessionTaskTable,
  TaskRevisionStopTable,
  TaskRevisionTable,
} from "./session.sql"
import { SessionStatus } from "./status"
import { SessionTask } from "./task"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"

export namespace SessionTaskRecovery {
  const log = Log.create({ service: "session.task-recovery" })
  type Owner = { task?: string; current?: string; revision?: string }

  function block(sessionID: SessionID, owner: Owner) {
    const task = owner.task
    const current = owner.current
    if (!task || !current) return false
    return Database.use(
      (tx) =>
        !!tx
          .update(SessionTaskTable)
          .set({ status: "blocked", time_updated: Date.now() })
          .where(
            and(
              eq(SessionTaskTable.id, task),
              eq(SessionTaskTable.session_id, sessionID),
              eq(SessionTaskTable.current_revision_id, current),
              inArray(SessionTaskTable.status, ["revising", "blocked", "running"]),
            ),
          )
          .returning({ id: SessionTaskTable.id })
          .get(),
    )
  }

  export async function resume(sessionID: SessionID) {
    const owner: Owner = {}
    return run(sessionID, owner).catch(async (err) => {
      await fail(sessionID, err, owner)
      throw err
    })
  }

  async function run(sessionID: SessionID, owner: Owner) {
    const stored = await SessionTask.get(sessionID)
    if (!stored) return false
    owner.task = stored.task.id
    owner.current = stored.revision.id
    owner.revision = stored.revision.id
    if (stored.task.status === "revising" || stored.task.status === "blocked") {
      const draft = Database.use((tx) =>
        tx
          .select()
          .from(TaskRevisionTable)
          .where(
            and(
              eq(TaskRevisionTable.task_id, stored.task.id),
              eq(TaskRevisionTable.previous_id, stored.revision.id),
              eq(TaskRevisionTable.status, "draft"),
            ),
          )
          .get(),
      )
      if (draft) {
        owner.revision = draft.id
        const scope = await SessionTask.scope(sessionID)
        const reason = `Stopped for confirmed task revision ${stored.revision.id}.`
        plan(stored.revision.id, scope, reason)
        reconcile(stored.revision.id)
        for (const [run, rows] of Map.groupBy(scope, (item) => item.run_id)) {
          const result = await SessionDelegation.stopScoped({
            sessionID,
            runID: run,
            childIDs: rows.map((item) => item.session_id),
            reason,
          })
          apply(stored.revision.id, result.stopped)
        }
        const results = await SessionResult.listForParent(sessionID)
        if (
          scope.some(
            (item) =>
              !terminal(SessionStatus.get(item.session_id)) ||
              !results.some(
                (result) =>
                  result.child_session_id === item.session_id &&
                  result.run_id === item.run_id &&
                  result.action_id === item.action_id,
              ),
          )
        )
          return true
        try {
          await SessionTask.activate({
            taskID: stored.task.id,
            revisionID: draft.id,
            bootstrap: true,
            stopped: count(stored.revision.id),
          })
        } catch (err) {
          if (err instanceof SessionTask.Conflict && advanced(sessionID, stored.task.id, draft.id)) return true
          throw err
        }
        owner.current = draft.id
      } else if (stored.task.status === "revising") return false
    }
    const current = await SessionTask.get(sessionID)
    if (!current) return false
    const next = pending(sessionID, current.task.id, current.revision.id)
    if (!next) {
      const done = settled(sessionID, current.task.id, current.revision.id)
      if (current.task.status === "blocked" && done) unblock(sessionID, current.task.id, current.revision.id)
      return done || bootstrapped(sessionID, current.task.id, current.revision.id)
    }
    await start(next)
    const sent = Database.use((tx) =>
      tx
        .select({ status: SessionEventOutboxTable.status })
        .from(SessionEventOutboxTable)
        .where(eq(SessionEventOutboxTable.id, next.id))
        .get(),
    )
    const task = typeof next.payload.task_id === "string" ? next.payload.task_id : ""
    const revision = typeof next.payload.revision_id === "string" ? next.payload.revision_id : ""
    if (sent?.status === "delivered" || sent?.status === "acked") unblock(sessionID, task, revision)
    return true
  }

  function advanced(sessionID: SessionID, taskID: string, revisionID: string) {
    return Database.use(
      (tx) =>
        !!tx
          .select({ id: SessionTaskTable.id })
          .from(SessionTaskTable)
          .innerJoin(TaskRevisionTable, eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id))
          .where(
            and(
              eq(SessionTaskTable.id, taskID),
              eq(SessionTaskTable.session_id, sessionID),
              eq(SessionTaskTable.current_revision_id, revisionID),
              eq(TaskRevisionTable.task_id, taskID),
              eq(TaskRevisionTable.status, "active"),
            ),
          )
          .get(),
    )
  }

  function terminal(status: SessionStatus.Info) {
    return (
      status.type === "completed" ||
      status.type === "terminal_reply" ||
      status.type === "user_completed" ||
      status.type === "aborted" ||
      status.type === "failed" ||
      status.type === "blocked" ||
      status.type === "timeout" ||
      status.type === "error" ||
      status.type === "archived"
    )
  }

  function plan(revision: string, scope: Awaited<ReturnType<typeof SessionTask.scope>>, reason: string) {
    const now = Date.now()
    const rows = scope
      .filter((item) => !terminal(SessionStatus.get(item.session_id)))
      .map((item) => ({
        revision_id: revision,
        child_session_id: item.session_id,
        run_id: item.run_id,
        action_id: item.action_id,
        state: "planned" as const,
        reason,
        time_created: now,
        time_applied: null,
      }))
    if (!rows.length) return
    Database.use((tx) => tx.insert(TaskRevisionStopTable).values(rows).onConflictDoNothing().run())
  }

  function reconcile(revision: string) {
    const rows = Database.use((tx) =>
      tx
        .select()
        .from(TaskRevisionStopTable)
        .where(and(eq(TaskRevisionStopTable.revision_id, revision), eq(TaskRevisionStopTable.state, "planned")))
        .all(),
    )
    apply(
      revision,
      rows
        .filter((item) => {
          const status = SessionStatus.get(item.child_session_id)
          return status.type === "user_completed" && status.message === item.reason
        })
        .map((item) => item.child_session_id),
    )
  }

  function apply(revision: string, children: SessionID[]) {
    if (!children.length) return
    Database.use((tx) =>
      tx
        .update(TaskRevisionStopTable)
        .set({ state: "applied", time_applied: Date.now() })
        .where(
          and(
            eq(TaskRevisionStopTable.revision_id, revision),
            eq(TaskRevisionStopTable.state, "planned"),
            inArray(TaskRevisionStopTable.child_session_id, children),
          ),
        )
        .run(),
    )
  }

  function count(revision: string) {
    return Database.use(
      (tx) =>
        tx
          .select({ id: TaskRevisionStopTable.child_session_id })
          .from(TaskRevisionStopTable)
          .where(and(eq(TaskRevisionStopTable.revision_id, revision), eq(TaskRevisionStopTable.state, "applied")))
          .all().length,
    )
  }

  export async function scan() {
    const started = Date.now()
    const ids = Database.use((tx) =>
      tx
        .select({ id: SessionTaskTable.session_id })
        .from(SessionTaskTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionTaskTable.session_id))
        .where(
          and(
            or(
              inArray(SessionTaskTable.status, ["revising", "blocked"]),
              and(
                eq(SessionTaskTable.status, "running"),
                exists(
                  tx
                    .select({ id: SessionEventOutboxTable.id })
                    .from(SessionEventOutboxTable)
                    .where(
                      and(
                        eq(SessionEventOutboxTable.session_id, SessionTaskTable.session_id),
                        eq(SessionEventOutboxTable.kind, "task_revision_bootstrap"),
                        inArray(SessionEventOutboxTable.status, ["pending", "delivering"]),
                        sql`${SessionEventOutboxTable.dedupe_key} = ${"task_revision_bootstrap:"} || ${SessionTaskTable.current_revision_id}`,
                      ),
                    ),
                ),
              ),
            ),
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
          ),
        )
        .all(),
    )
    const results: boolean[] = []
    for (let index = 0; index < ids.length; index += 4) {
      const batch = await Promise.all(
        ids.slice(index, index + 4).map((item) =>
          resume(item.id).catch((err) => {
            log.warn("task recovery scan blocked", { err, sessionID: item.id })
            return false
          }),
        ),
      )
      results.push(...batch)
    }
    log.info("task recovery scan completed", { candidates: ids.length, duration: Date.now() - started })
    return results
  }

  async function fail(sessionID: SessionID, err: unknown, owner: Owner) {
    const task = owner.task
    const id = owner.revision
    if (!task || !id || !block(sessionID, owner)) return
    const revision = Database.use((tx) =>
      tx
        .select()
        .from(TaskRevisionTable)
        .where(and(eq(TaskRevisionTable.id, id), eq(TaskRevisionTable.task_id, task)))
        .get(),
    )
    if (!revision) return
    const messageID = revision.source_message_id
    if (!messageID) return
    const msg = await MessageV2.get({ sessionID, messageID }).catch(() => undefined)
    if (!msg) return
    const prev = msg.parts.find(
      (part) =>
        part.type === "text" &&
        part.metadata?.kind === "task_update_progress" &&
        part.metadata.draft_revision_id === revision.id,
    )
    const now = Date.now()
    await Session.updatePart({
      id: prev?.id ?? PartID.ascending(),
      messageID,
      sessionID,
      type: "text",
      text: "Task revision shutdown is blocked.",
      synthetic: true,
      ignored: true,
      metadata: {
        ...(prev?.type === "text" ? prev.metadata : {}),
        kind: "task_update_progress",
        draft_revision_id: revision.id,
        old_revision_id: revision.previous_id,
        status: "blocked",
        error: err instanceof Error ? err.message : String(err),
      },
      time: { start: prev?.type === "text" ? (prev.time?.start ?? now) : now, end: now },
    })
  }

  function pending(sessionID: SessionID, taskID: string, revisionID: string) {
    return Database.use((tx) =>
      tx
        .select()
        .from(SessionEventOutboxTable)
        .where(
          and(
            eq(SessionEventOutboxTable.session_id, sessionID),
            eq(SessionEventOutboxTable.kind, "task_revision_bootstrap"),
            inArray(SessionEventOutboxTable.status, ["pending", "delivering"]),
          ),
        )
        .all()
        .find((row) => row.payload.task_id === taskID && row.payload.revision_id === revisionID),
    )
  }

  function bootstrapped(sessionID: SessionID, taskID: string, revisionID: string) {
    return Database.use(
      (tx) =>
        !!tx
          .select({ payload: SessionEventOutboxTable.payload })
          .from(SessionEventOutboxTable)
          .where(
            and(
              eq(SessionEventOutboxTable.session_id, sessionID),
              eq(SessionEventOutboxTable.kind, "task_revision_bootstrap"),
            ),
          )
          .all()
          .find((row) => row.payload.task_id === taskID && row.payload.revision_id === revisionID),
    )
  }

  function settled(sessionID: SessionID, taskID: string, revisionID: string) {
    return Database.use((tx) =>
      tx
        .select({ payload: SessionEventOutboxTable.payload })
        .from(SessionEventOutboxTable)
        .where(
          and(
            eq(SessionEventOutboxTable.session_id, sessionID),
            eq(SessionEventOutboxTable.kind, "task_revision_bootstrap"),
            inArray(SessionEventOutboxTable.status, ["delivered", "acked"]),
          ),
        )
        .all()
        .some((row) => row.payload.task_id === taskID && row.payload.revision_id === revisionID),
    )
  }

  function unblock(sessionID: SessionID, taskID: string, revisionID: string) {
    if (!taskID || !revisionID) return
    Database.use((tx) =>
      tx
        .update(SessionTaskTable)
        .set({ status: "running", time_updated: Date.now() })
        .where(
          and(
            eq(SessionTaskTable.id, taskID),
            eq(SessionTaskTable.session_id, sessionID),
            eq(SessionTaskTable.status, "blocked"),
            eq(SessionTaskTable.current_revision_id, revisionID),
          ),
        )
        .run(),
    )
  }

  function scope(row: typeof SessionEventOutboxTable.$inferSelect) {
    const task = typeof row.payload.task_id === "string" ? row.payload.task_id : ""
    const revision = typeof row.payload.revision_id === "string" ? row.payload.revision_id : ""
    if (!task || !revision) return
    return and(
      eq(SessionTaskTable.id, task),
      eq(SessionTaskTable.session_id, row.session_id),
      eq(SessionTaskTable.current_revision_id, revision),
    )
  }

  function guard(
    tx: Database.TxOrDb,
    row: typeof SessionEventOutboxTable.$inferSelect,
    status: typeof SessionEventOutboxTable.$inferSelect.status,
    updated?: number,
  ) {
    const current = scope(row)
    if (!current) return
    return and(
      eq(SessionEventOutboxTable.id, row.id),
      eq(SessionEventOutboxTable.session_id, row.session_id),
      eq(SessionEventOutboxTable.payload, row.payload),
      eq(SessionEventOutboxTable.status, status),
      updated === undefined ? undefined : eq(SessionEventOutboxTable.updated_at, updated),
      exists(tx.select({ id: SessionTaskTable.id }).from(SessionTaskTable).where(current)),
    )
  }

  function valid(
    row: typeof SessionEventOutboxTable.$inferSelect,
    status: typeof SessionEventOutboxTable.$inferSelect.status,
    updated?: number,
  ) {
    return Database.use((tx) => {
      const where = guard(tx, row, status, updated)
      if (!where) return false
      return !!tx.select({ id: SessionEventOutboxTable.id }).from(SessionEventOutboxTable).where(where).get()
    })
  }

  function retry(row: typeof SessionEventOutboxTable.$inferSelect, updated: number, err?: unknown) {
    Database.use((tx) =>
      tx
        .update(SessionEventOutboxTable)
        .set({
          status: "pending",
          error: err === undefined ? null : err instanceof Error ? err.message : String(err),
          updated_at: Date.now(),
        })
        .where(
          and(
            eq(SessionEventOutboxTable.id, row.id),
            eq(SessionEventOutboxTable.payload, row.payload),
            eq(SessionEventOutboxTable.status, "delivering"),
            eq(SessionEventOutboxTable.updated_at, updated),
          ),
        )
        .run(),
    )
  }

  async function start(row: typeof SessionEventOutboxTable.$inferSelect): Promise<boolean> {
    const now = Date.now()
    const data = row.payload
    const message = typeof data.message_id === "string" ? MessageID.make(data.message_id) : MessageID.ascending()
    if (!valid(row, row.status, row.updated_at)) return true
    const existing = await MessageV2.get({ sessionID: row.session_id, messageID: message }).catch(() => undefined)
    if (row.status === "delivering") {
      if (existing) {
        Database.use((tx) => {
          const where = guard(tx, row, "delivering", row.updated_at)
          if (!where) return
          tx.update(SessionEventOutboxTable)
            .set({ status: "delivered", delivered_at: now, acked_at: null, updated_at: now, error: null })
            .where(where)
            .run()
        })
        return true
      }
      if (row.updated_at > now - 30_000) return true
      const reset = Database.use((tx) => {
        const where = guard(tx, row, "delivering", row.updated_at)
        if (!where) return
        return tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", updated_at: now })
          .where(where)
          .returning()
          .get()
      })
      return reset ? start(reset) : true
    }
    if (row.status !== "pending") return true
    const stamp = Date.now()
    const claimed = Database.use((tx) => {
      const where = guard(tx, row, "pending", row.updated_at)
      if (!where) return
      return tx
        .update(SessionEventOutboxTable)
        .set({ status: "delivering", updated_at: stamp, error: null })
        .where(where)
        .returning({ id: SessionEventOutboxTable.id })
        .get()
    })
    if (!claimed) return true
    if (!valid(row, "delivering", stamp)) {
      retry(row, stamp)
      return true
    }
    const session = await Session.get(row.session_id)
    const task = await SessionTask.get(row.session_id)
    if (
      !task ||
      task.task.id !== data.task_id ||
      task.revision.id !== data.revision_id ||
      task.revision.status !== "active"
    ) {
      retry(row, stamp, new Error("task_revision_bootstrap_stale"))
      return true
    }
    if (!valid(row, "delivering", stamp)) {
      retry(row, stamp)
      return true
    }
    await SessionPrompt.prompt({
      sessionID: row.session_id,
      messageID: message,
      agent: session.agent,
      metadata: {
        internal: true,
        source: "task_revision_bootstrap",
        task_id: data.task_id,
        revision_id: data.revision_id,
      },
      parts: [
        {
          type: "text",
          text: SessionTask.request(task.revision.body),
        },
      ],
    }).catch((err) => {
      const owned = valid(row, "delivering", stamp)
      retry(row, stamp, err)
      if (owned) throw err
    })
    if (!valid(row, "delivering", stamp)) {
      retry(row, stamp)
      return true
    }
    Database.use((tx) => {
      const where = guard(tx, row, "delivering", stamp)
      if (!where) return
      tx.update(SessionEventOutboxTable)
        .set({ status: "delivered", delivered_at: Date.now(), acked_at: null, updated_at: Date.now(), error: null })
        .where(where)
        .run()
    })
    return true
  }
}
