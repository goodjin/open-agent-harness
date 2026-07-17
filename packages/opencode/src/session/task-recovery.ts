import { and, Database, eq, inArray } from "@/storage/db"
import { Session } from "."
import { SessionDelegation } from "./delegation"
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { MessageID, SessionID } from "./schema"
import { SessionEventOutboxTable, SessionTaskTable, TaskRevisionTable } from "./session.sql"
import { SessionTask } from "./task"

export namespace SessionTaskRecovery {
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
      await SessionTask.activate({ taskID: stored.task.id, revisionID: draft.id, bootstrap: true })
    }
    const next = pending(sessionID)
    if (!next) return bootstrapped(sessionID)
    await start(next)
    return true
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
            inArray(SessionEventOutboxTable.status, ["pending", "delivered"]),
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

  async function start(row: typeof SessionEventOutboxTable.$inferSelect) {
    const data = row.payload
    const message = typeof data.message_id === "string" ? MessageID.make(data.message_id) : MessageID.ascending()
    const existing = await MessageV2.get({ sessionID: row.session_id, messageID: message }).catch(() => undefined)
    if (!existing) {
      const claimed = Database.use((tx) =>
        tx
          .update(SessionEventOutboxTable)
          .set({ status: "delivered", delivered_at: Date.now(), updated_at: Date.now(), error: null })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              inArray(SessionEventOutboxTable.status, ["pending", "delivered"]),
            ),
          )
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
            .where(eq(SessionEventOutboxTable.id, row.id))
            .run(),
        )
        throw err
      })
    }
    Database.use((tx) =>
      tx
        .update(SessionEventOutboxTable)
        .set({ status: "acked", acked_at: Date.now(), updated_at: Date.now(), error: null })
        .where(eq(SessionEventOutboxTable.id, row.id))
        .run(),
    )
    return true
  }
}
