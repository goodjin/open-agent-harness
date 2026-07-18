import { Identifier } from "@/id/id"
import { and, Database, desc, eq, inArray } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { AssignmentTable, SessionTable, SessionTaskTable } from "./session.sql"
import type { AgentProtocol } from "@/protocol/schema"
import type { MessageID, SessionID } from "./schema"

export namespace SessionAssignment {
  export type Status = "pending" | "running" | "completed" | "failed" | "cancelled" | "superseded"
  export type Source = "confirm" | "delegation"
  export type Result = "completed" | "partial" | "blocked" | "failed" | "waiting_user"

  export class Conflict extends Error {
    constructor(message = "session_assignment_conflict") {
      super(message)
      this.name = "SessionAssignmentConflict"
    }
  }

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
    return reuse(
      put({
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
      }),
      { sessionID: input.sessionID, runID: input.runID, actionID: input.actionID },
    )
  }

  export async function delegate(input: {
    action: AgentProtocol.Action
    childID: SessionID
    messageID: MessageID
    plan?: string
    runID: string
    sessionID: SessionID
  }) {
    const task = Database.use((tx) =>
      tx
        .select({ status: SessionTaskTable.status })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, input.sessionID))
        .get(),
    )
    if (task?.status === "revising" || task?.status === "blocked") throw new Conflict("session_task_revision_frozen")
    const prev = await bySource({
      sessionID: input.sessionID,
      runID: input.runID,
      actionID: input.action.id,
    })
    if (prev) return prev
    const parent = await active(input.sessionID)
    const data = object(input.action.input)
    return reuse(
      put({
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
      }),
      { sessionID: input.sessionID, runID: input.runID, actionID: input.action.id },
    )
  }

  export async function active(sessionID: SessionID) {
    const row = Database.use((tx) =>
      tx
        .select()
        .from(AssignmentTable)
        .where(and(eq(AssignmentTable.session_id, sessionID), inArray(AssignmentTable.status, ["pending", "running"])))
        .orderBy(desc(AssignmentTable.time_updated))
        .get(),
    )
    return row ? from(row) : undefined
  }

  export async function unique(sessionID: SessionID, source?: Source) {
    const rows = Database.use((tx) =>
      tx
        .select()
        .from(AssignmentTable)
        .where(
          source
            ? and(
                eq(AssignmentTable.session_id, sessionID),
                eq(AssignmentTable.source_type, source),
                inArray(AssignmentTable.status, ["pending", "running"]),
              )
            : and(eq(AssignmentTable.session_id, sessionID), inArray(AssignmentTable.status, ["pending", "running"])),
        )
        .orderBy(desc(AssignmentTable.time_updated))
        .limit(2)
        .all(),
    )
    if (rows.length > 1) return null
    return rows.length === 1 ? from(rows[0]!) : undefined
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
    const body = await Storage.read<unknown>(item.content_ref.split("/")).catch(() => undefined)
    if (!body || typeof body !== "object" || Array.isArray(body)) return
    const legacy = item.content_ref.split("/").at(-1)?.startsWith("rev-")
    const plan = "plan" in body && typeof body.plan === "string" ? body.plan : undefined
    const digest = legacy && plan !== undefined ? hash(plan) : hash(canonical(body))
    if (digest !== item.content_hash) return
    return body
  }

  export function fail(id: string) {
    return Database.transaction(
      (tx) => {
        const current = tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, id)).get()
        if (!current) return
        if (current.status === "failed") return from(current)
        const row = tx
          .update(AssignmentTable)
          .set({ status: "failed", time_updated: Date.now() })
          .where(and(eq(AssignmentTable.id, id), inArray(AssignmentTable.status, ["pending", "running"])))
          .returning()
          .get()
        if (!row) throw new Conflict()
        return from(row)
      },
      { behavior: "immediate" },
    )
  }

  export function withCurrent(
    tx: Database.TxOrDb,
    input: {
      assignment: Info
      sessionID: SessionID
      sourceSessionID: SessionID
      runID: string
      actionIDs: string[]
      source: Source
    },
  ) {
    const row = tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, input.assignment.id)).get()
    const active = tx
      .select()
      .from(AssignmentTable)
      .where(
        and(eq(AssignmentTable.session_id, input.sessionID), inArray(AssignmentTable.status, ["pending", "running"])),
      )
      .orderBy(desc(AssignmentTable.time_updated))
      .get()
    if (!row || active?.id !== row.id) return
    const item = from(row)
    if (JSON.stringify(item) !== JSON.stringify(input.assignment)) return
    if (
      item.status !== "running" ||
      item.source_type !== input.source ||
      item.session_id !== input.sessionID ||
      item.source_session_id !== input.sourceSessionID ||
      item.source_run_id !== input.runID ||
      !item.source_action_id ||
      !input.actionIDs.includes(item.source_action_id)
    )
      return
    return item
  }

  export function consume(tx: Database.TxOrDb, input: Parameters<typeof withCurrent>[1]) {
    const current = withCurrent(tx, input)
    if (!current) return
    const row = tx
      .update(AssignmentTable)
      .set({ status: "completed", time_updated: Date.now() })
      .where(
        and(
          eq(AssignmentTable.id, current.id),
          eq(AssignmentTable.status, "running"),
          eq(AssignmentTable.content_ref, current.content_ref),
          eq(AssignmentTable.content_hash, current.content_hash),
          eq(AssignmentTable.content_version, current.content_version),
        ),
      )
      .returning()
      .get()
    if (!row) throw new Conflict()
    return from(row)
  }

  export function withStatus(tx: Database.TxOrDb, assignment: Info, status: Status) {
    const row = tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, assignment.id)).get()
    if (!row) return
    const item = from(row)
    if (item.status !== status || JSON.stringify(item) !== JSON.stringify(assignment)) return
    return item
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
    const id = input.id ?? Identifier.ascending("payload").replace(/^payload_/, "assignment_")
    const version = (current?.content_version ?? 0) + 1
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
    const digest = hash(canonical(body))
    const ref = ["session_assignment_content", id, `sha256-${digest}`].join("/")
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
      content_hash: digest,
      content_version: version,
      result_ref: current?.result_ref ?? null,
      result_status: current?.result_status ?? null,
      time_created: current?.time_created ?? now,
      time_updated: now,
    }
    return Database.transaction(
      (tx) => {
        if (current) {
          const saved = tx
            .update(AssignmentTable)
            .set(row)
            .where(
              and(
                eq(AssignmentTable.id, current.id),
                eq(AssignmentTable.content_version, current.content_version),
                eq(AssignmentTable.content_ref, current.content_ref),
                eq(AssignmentTable.content_hash, current.content_hash),
              ),
            )
            .returning()
            .get()
          if (!saved) throw new Conflict()
          return from(saved)
        }
        const active = tx
          .select({ id: AssignmentTable.id })
          .from(AssignmentTable)
          .where(
            and(
              eq(AssignmentTable.session_id, input.sessionID),
              inArray(AssignmentTable.status, ["pending", "running"]),
            ),
          )
          .orderBy(desc(AssignmentTable.time_updated))
          .get()
        if (active)
          tx.update(AssignmentTable)
            .set({ status: "superseded", time_updated: now })
            .where(eq(AssignmentTable.id, active.id))
            .run()
        return from(tx.insert(AssignmentTable).values(row).returning().get())
      },
      { behavior: "immediate" },
    )
  }

  async function reuse(value: Promise<Info>, source: { sessionID: SessionID; runID: string; actionID: string }) {
    return value.catch(async (err) => {
      const found = await bySource(source)
      if (found) return found
      throw err
    })
  }

  async function targetSession(input: { op: "create" | "update"; parentID: SessionID; target: string }) {
    if (input.target === "self") {
      const row = Database.use((tx) => tx.select().from(SessionTable).where(eq(SessionTable.id, input.parentID)).get())
      if (!row) throw new Error(`Session not found: ${input.parentID}`)
      return { id: row.id, parent_id: row.parent_id ?? undefined }
    }
    const row = Database.use((tx) =>
      tx
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.target as SessionID))
        .get(),
    )
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

  function canonical(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`
    if (input && typeof input === "object") {
      const body = input as Record<string, unknown>
      return `{${Object.keys(body)
        .filter((key) => body[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(body[key])}`)
        .join(",")}}`
    }
    return JSON.stringify(input)
  }

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function text(input: unknown) {
    if (typeof input === "string" && input.trim().length > 0) return input.trim()
  }
}
