import { and, Database, eq, inArray } from "@/storage/db"
import { Session } from "."
import { SessionDelegation } from "./delegation"
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { SessionResult } from "./result"
import { MessageID, SessionID } from "./schema"
import { SessionEventOutboxTable, SessionTaskTable, TaskRevisionTable } from "./session.sql"
import { SessionStatus } from "./status"
import { SessionTask } from "./task"

export namespace SessionTaskRecovery {
  export function block(sessionID: SessionID) {
    Database.use((tx) =>
      tx
        .update(SessionTaskTable)
        .set({ status: "blocked", time_updated: Date.now() })
        .where(
          and(
            eq(SessionTaskTable.session_id, sessionID),
            inArray(SessionTaskTable.status, ["revising", "blocked"]),
          ),
        )
        .run(),
    )
  }

  export async function resume(sessionID: SessionID) {
    const stored = await SessionTask.get(sessionID)
    const outbox = pending(sessionID)
    if (!stored) return outbox ? start(outbox) : false
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
      if (!draft) return false
      const scope = await SessionTask.scope(sessionID)
      for (const [run, rows] of Map.groupBy(scope, (item) => item.run_id)) {
        await SessionDelegation.stop({
          sessionID,
          runID: run,
          childIDs: rows.map((item) => item.session_id),
          reason: "Stopped for confirmed task revision.",
        })
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
      await SessionTask.activate({ taskID: stored.task.id, revisionID: draft.id, bootstrap: true })
    }
    const next = pending(sessionID)
    if (!next) return bootstrapped(sessionID)
    await start(next)
    return true
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

  export async function scan() {
    const ids = Database.use((tx) =>
      tx
        .select({ id: SessionTaskTable.session_id })
        .from(SessionTaskTable)
        .where(inArray(SessionTaskTable.status, ["revising", "blocked", "running"]))
        .all(),
    )
    return Promise.all(ids.map((item) => resume(item.id).catch(() => false)))
  }

  function pending(sessionID: SessionID) {
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
        .get(),
    )
  }

  function bootstrapped(sessionID: SessionID) {
    return Database.use((tx) =>
      !!tx
        .select({ id: SessionEventOutboxTable.id })
        .from(SessionEventOutboxTable)
        .where(
          and(
            eq(SessionEventOutboxTable.session_id, sessionID),
            eq(SessionEventOutboxTable.kind, "task_revision_bootstrap"),
          ),
        )
        .get(),
    )
  }

  async function start(row: typeof SessionEventOutboxTable.$inferSelect): Promise<boolean> {
    const now = Date.now()
    const data = row.payload
    const message = typeof data.message_id === "string" ? MessageID.make(data.message_id) : MessageID.ascending()
    const existing = await MessageV2.get({ sessionID: row.session_id, messageID: message }).catch(() => undefined)
    if (row.status === "delivering") {
      if (existing) {
        Database.use((tx) =>
          tx
            .update(SessionEventOutboxTable)
            .set({ status: "delivered", delivered_at: now, acked_at: now, updated_at: now, error: null })
            .where(and(eq(SessionEventOutboxTable.id, row.id), eq(SessionEventOutboxTable.status, "delivering")))
            .run(),
        )
        return true
      }
      if (row.updated_at > now - 30_000) return true
      const reset = Database.use((tx) =>
        tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", updated_at: now })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              eq(SessionEventOutboxTable.status, "delivering"),
              eq(SessionEventOutboxTable.updated_at, row.updated_at),
            ),
          )
          .returning()
          .get(),
      )
      return reset ? start(reset) : true
    }
    if (row.status !== "pending") return true
    const claimed = Database.use((tx) =>
      tx
        .update(SessionEventOutboxTable)
        .set({ status: "delivering", updated_at: now, error: null })
        .where(and(eq(SessionEventOutboxTable.id, row.id), eq(SessionEventOutboxTable.status, "pending")))
        .returning({ id: SessionEventOutboxTable.id })
        .get(),
    )
    if (!claimed) return true
    const session = await Session.get(row.session_id)
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
          text: [
            "A confirmed Task revision is now active.",
            "Inspect the current Task workflow and reusable results, then continue the revised work.",
            "Do not revive actions or child sessions from the archived revision.",
          ].join("\n"),
        },
      ],
    }).catch((err) => {
      Database.use((tx) =>
        tx
          .update(SessionEventOutboxTable)
          .set({ status: "pending", error: err instanceof Error ? err.message : String(err), updated_at: Date.now() })
          .where(and(eq(SessionEventOutboxTable.id, row.id), eq(SessionEventOutboxTable.status, "delivering")))
          .run(),
      )
      throw err
    })
    Database.use((tx) =>
      tx
        .update(SessionEventOutboxTable)
        .set({ status: "delivered", delivered_at: Date.now(), acked_at: Date.now(), updated_at: Date.now(), error: null })
        .where(and(eq(SessionEventOutboxTable.id, row.id), eq(SessionEventOutboxTable.status, "delivering")))
        .run(),
    )
    return true
  }
}
