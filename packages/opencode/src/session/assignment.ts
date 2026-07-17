import { Identifier } from "@/id/id"
import { and, Database, desc, eq, ne } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { AssignmentTable, SessionTable } from "./session.sql"
import type { AgentProtocol } from "@/protocol/schema"
import type { MessageID, SessionID } from "./schema"

export namespace SessionAssignment {
  export type Status = "pending" | "running" | "completed" | "failed" | "cancelled" | "superseded"
  export type Source = "confirm" | "delegation"
  export type Result = "completed" | "partial" | "blocked" | "failed" | "waiting_user"

  export type Info = {
    id: string
    parent_id?: string
    session_id: SessionID
    source_type: Source
    source_session_id?: SessionID
    source_message_id?: MessageID
    source_run_id?: string
    source_action_id?: string
    target: string
    title: string
    status: Status
    content_ref: string
    content_hash: string
    content_version: number
    result_ref?: string
    result_status?: Result
    time_created: number
    time_updated: number
  }

  export async function confirm(input: {
    action: AgentProtocol.Action
    messageID: MessageID
    plan: string
    runID: string
    sessionID: SessionID
  }) {
    return apply({
      actionID: input.action.id,
      assignment: object(input.action.input).assignment,
      messageID: input.messageID,
      plan: input.plan,
      runID: input.runID,
      sessionID: input.sessionID,
      title: input.action.title,
    })
  }

  export async function apply(input: {
    actionID: string
    assignment: unknown
    messageID: MessageID
    plan: string
    runID: string
    sessionID: SessionID
    title: string
  }) {
    const meta = object(input.assignment)
    const op = meta.op === "create" || meta.op === "update" || meta.op === "handoff" ? meta.op : undefined
    if (!op) return
    const target = text(meta.target) ?? "self"
    const session =
      op === "handoff"
        ? await targetSession({ op: "create", parentID: input.sessionID, target: "self" })
        : await targetSession({ op, parentID: input.sessionID, target })
    const prev = await bySource({
      sessionID: input.sessionID,
      runID: input.runID,
      actionID: input.actionID,
    })
    if (prev) return prev
    const current = op === "update" ? await active(session.id) : undefined
    return put({
      id: current?.id,
      parentID: current?.parent_id,
      sessionID: session.id,
      source: "confirm",
      sourceSessionID: input.sessionID,
      sourceMessageID: input.messageID,
      sourceRunID: input.runID,
      sourceActionID: input.actionID,
      target,
      title: input.title,
      status: current?.status ?? "running",
      plan: input.plan,
      assignment: { op, target },
    })
  }

  export async function delegate(input: {
    action: AgentProtocol.Action
    childID: SessionID
    messageID: MessageID
    plan?: string
    runID: string
    sessionID: SessionID
  }) {
    const prev = await bySource({
      sessionID: input.sessionID,
      runID: input.runID,
      actionID: input.action.id,
    })
    if (prev) return prev
    const parent = await active(input.sessionID)
    const data = object(input.action.input)
    return put({
      parentID: parent?.id,
      sessionID: input.childID,
      source: "delegation",
      sourceSessionID: input.sessionID,
      sourceMessageID: input.messageID,
      sourceRunID: input.runID,
      sourceActionID: input.action.id,
      target: input.action.executor.target,
      title: input.action.title,
      status: "running",
      plan: input.plan ?? text(data.prompt) ?? input.action.title,
    })
  }

  export async function active(sessionID: SessionID) {
    const row = Database.use((tx) =>
      tx
        .select()
        .from(AssignmentTable)
        .where(and(eq(AssignmentTable.session_id, sessionID), ne(AssignmentTable.status, "superseded")))
        .orderBy(desc(AssignmentTable.time_updated))
        .get(),
    )
    return row ? from(row) : undefined
  }

  export async function bySource(input: { sessionID: SessionID; runID?: string; actionID?: string }) {
    if (!input.runID || !input.actionID) return
    const run = input.runID
    const action = input.actionID
    const row = Database.use((tx) =>
      tx
        .select()
        .from(AssignmentTable)
        .where(
          and(
            eq(AssignmentTable.source_session_id, input.sessionID),
            eq(AssignmentTable.source_run_id, run),
            eq(AssignmentTable.source_action_id, action),
          ),
        )
        .orderBy(desc(AssignmentTable.time_updated))
        .get(),
    )
    return row ? from(row) : undefined
  }

  export async function content(id: string) {
    const item = await get(id)
    if (!item) return
    return Storage.read<unknown>(item.content_ref.split("/")).catch(() => undefined)
  }

  export async function get(id: string) {
    const row = Database.use((tx) => tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, id)).get())
    return row ? from(row) : undefined
  }

  async function put(input: {
    id?: string
    parentID?: string
    sessionID: SessionID
    source: Source
    sourceSessionID?: SessionID
    sourceMessageID?: MessageID
    sourceRunID?: string
    sourceActionID?: string
    target: string
    title: string
    status: Status
    plan: string
    assignment?: { op: "create" | "update" | "handoff"; target: string }
  }) {
    const now = Date.now()
    const current = input.id ? await get(input.id) : undefined
    if (!input.id) {
      const active = await SessionAssignment.active(input.sessionID)
      if (active) {
        Database.use((tx) =>
          tx
            .update(AssignmentTable)
            .set({ status: "superseded", time_updated: now })
            .where(eq(AssignmentTable.id, active.id))
            .run(),
        )
      }
    }
    const id = input.id ?? Identifier.ascending("payload").replace(/^payload_/, "assignment_")
    const version = (current?.content_version ?? 0) + 1
    const ref = ["session_assignment_content", id, `rev-${version}`].join("/")
    const body = {
      type: "assignment.content",
      version: 1,
      assignment_id: id,
      revision: version,
      plan: input.plan,
      assignment: input.assignment,
      source: {
        type: input.source,
        session_id: input.sourceSessionID,
        message_id: input.sourceMessageID,
        run_id: input.sourceRunID,
        action_id: input.sourceActionID,
      },
      created_at: now,
    }
    await Storage.write(ref.split("/"), body)
    const row = {
      id,
      parent_id: input.parentID ?? null,
      session_id: input.sessionID,
      source_type: input.source,
      source_session_id: input.sourceSessionID ?? null,
      source_message_id: input.sourceMessageID ?? null,
      source_run_id: input.sourceRunID ?? null,
      source_action_id: input.sourceActionID ?? null,
      target: input.target,
      title: input.title,
      status: input.status,
      content_ref: ref,
      content_hash: hash(input.plan),
      content_version: version,
      result_ref: current?.result_ref ?? null,
      result_status: current?.result_status ?? null,
      time_created: current?.time_created ?? now,
      time_updated: now,
    }
    return from(
      Database.use((tx) => {
        const found = tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, id)).get()
        if (found) return tx.update(AssignmentTable).set(row).where(eq(AssignmentTable.id, id)).returning().get()
        return tx.insert(AssignmentTable).values(row).returning().get()
      }),
    )
  }

  async function targetSession(input: { op: "create" | "update"; parentID: SessionID; target: string }) {
    if (input.target === "self") {
      const row = Database.use((tx) => tx.select().from(SessionTable).where(eq(SessionTable.id, input.parentID)).get())
      if (!row) throw new Error(`Session not found: ${input.parentID}`)
      return { id: row.id, parent_id: row.parent_id ?? undefined }
    }
    const row = Database.use((tx) => tx.select().from(SessionTable).where(eq(SessionTable.id, input.target as SessionID)).get())
    if (!row) throw new Error(`Assignment target session not found: ${input.target}`)
    if (row.parent_id !== input.parentID) {
      throw new Error(`Assignment target ${input.target} is not a direct child of ${input.parentID}`)
    }
    return { id: row.id, parent_id: row.parent_id ?? undefined }
  }

  function from(row: typeof AssignmentTable.$inferSelect): Info {
    return {
      id: row.id,
      parent_id: row.parent_id ?? undefined,
      session_id: row.session_id,
      source_type: row.source_type,
      source_session_id: row.source_session_id ?? undefined,
      source_message_id: row.source_message_id ?? undefined,
      source_run_id: row.source_run_id ?? undefined,
      source_action_id: row.source_action_id ?? undefined,
      target: row.target,
      title: row.title,
      status: row.status,
      content_ref: row.content_ref,
      content_hash: row.content_hash,
      content_version: row.content_version,
      result_ref: row.result_ref ?? undefined,
      result_status: row.result_status ?? undefined,
      time_created: row.time_created,
      time_updated: row.time_updated,
    }
  }

  function hash(input: string) {
    return new Bun.CryptoHasher("sha256").update(input).digest("hex")
  }

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function text(input: unknown) {
    if (typeof input === "string" && input.trim().length > 0) return input.trim()
  }
}
