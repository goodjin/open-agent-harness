import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { and, Database, desc, eq } from "@/storage/db"
import { SessionResultTable } from "./session.sql"
import type { SessionID } from "./schema"

export namespace SessionResult {
  export type Carrier = "action_result" | "agent_protocol_output" | "fallback_summary" | "plain_text_result" | "synthetic"
  export type Status = "completed" | "partial" | "blocked" | "failed" | "waiting_user" | "terminal_reply"

  export type Info = {
    id: string
    carrier: Carrier
    status: Status
    satisfying: boolean
    session_id: SessionID
    parent_session_id?: SessionID
    child_session_id?: SessionID
    run_id?: string
    action_id?: string
    target_action_id?: string
    raw_ref: string
    summary?: string
    created_at: number
  }

  export type Parsed = Info & {
    output?: string
    action_result?: Record<string, unknown>
    protocol_result?: Record<string, unknown>
    action_title?: string
    parent_agent?: string
    agent?: string
    result_policy?: string
    completed_at?: number
  }

  export type Put = {
    id?: string
    carrier: Carrier
    status: Status
    satisfying: boolean
    sessionID: SessionID
    parentSessionID?: SessionID
    childSessionID?: SessionID
    runID?: string
    actionID?: string
    targetActionID?: string
    summary?: string
    raw: unknown
  }

  const cache = new Map<string, unknown>()

  export async function put(input: Put) {
    const prev = input.id
      ? await get(input.id)
      : await find({
          parentSessionID: input.parentSessionID,
          childSessionID: input.childSessionID,
          runID: input.runID,
          actionID: input.actionID,
        })
    const id = prev?.id ?? input.id ?? Identifier.ascending("payload").replace(/^payload_/, "result_")
    const ref = ["session_result_raw", id].join("/")
    await Storage.write(ref.split("/"), input.raw)
    cache.set(id, input.raw)
    const row = {
      id,
      carrier: input.carrier,
      status: input.status,
      satisfying: input.satisfying,
      session_id: input.sessionID,
      parent_session_id: input.parentSessionID ?? null,
      child_session_id: input.childSessionID ?? null,
      run_id: input.runID ?? null,
      action_id: input.actionID ?? null,
      target_action_id: input.targetActionID ?? null,
      raw_ref: ref,
      summary: input.summary ?? null,
      created_at: prev?.created_at ?? Date.now(),
    }
    return from(
      Database.use((tx) => {
        const found = tx.select().from(SessionResultTable).where(eq(SessionResultTable.id, id)).get()
        if (found)
          return tx
            .update(SessionResultTable)
            .set(row)
            .where(eq(SessionResultTable.id, id))
            .returning()
            .get()
        return tx.insert(SessionResultTable).values(row).returning().get()
      }),
    )
  }

  export async function get(id: string) {
    if (!id) return
    const row = Database.use((tx) => tx.select().from(SessionResultTable).where(eq(SessionResultTable.id, id)).get())
    return row ? from(row) : undefined
  }

  export async function find(input: {
    parentSessionID?: SessionID
    childSessionID?: SessionID
    runID?: string
    actionID?: string
  }) {
    if (!input.parentSessionID || !input.childSessionID) return
    const cond = [
      eq(SessionResultTable.parent_session_id, input.parentSessionID),
      eq(SessionResultTable.child_session_id, input.childSessionID),
    ]
    if (input.runID) cond.push(eq(SessionResultTable.run_id, input.runID))
    if (input.actionID) cond.push(eq(SessionResultTable.action_id, input.actionID))
    const row = Database.use((tx) =>
      tx.select().from(SessionResultTable).where(and(...cond)).orderBy(desc(SessionResultTable.created_at)).get(),
    )
    return row ? from(row) : undefined
  }

  export async function listForParentRun(input: { parentSessionID: SessionID; runID: string }) {
    const rows = Database.use((tx) =>
      tx
        .select()
        .from(SessionResultTable)
        .where(and(eq(SessionResultTable.parent_session_id, input.parentSessionID), eq(SessionResultTable.run_id, input.runID)))
        .orderBy(desc(SessionResultTable.created_at))
        .all(),
    )
    return rows.map(from)
  }

  export async function listForParent(parentSessionID: SessionID) {
    const rows = Database.use((tx) =>
      tx
        .select()
        .from(SessionResultTable)
        .where(eq(SessionResultTable.parent_session_id, parentSessionID))
        .orderBy(desc(SessionResultTable.created_at))
        .all(),
    )
    return rows.map(from)
  }

  export async function raw(id: string) {
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const rec = await get(id)
    if (!rec) return
    const out = await Storage.read<unknown>(rec.raw_ref.split("/")).catch(() => undefined)
    if (out !== undefined) cache.set(id, out)
    return out
  }

  export async function parse(id: string): Promise<Parsed | undefined> {
    const rec = await get(id)
    if (!rec) return
    const data = object(await raw(id))
    const input = object(data.input)
    const item = object(data.item)
    return {
      ...rec,
      output: text(data.output),
      action_result: Object.keys(input).length ? input : undefined,
      protocol_result: Object.keys(item).length ? item : undefined,
      action_title: text(data.action_title),
      parent_agent: text(data.parent_agent),
      agent: text(data.agent),
      result_policy: text(data.result_policy),
      completed_at: number(data.completed_at),
    }
  }

  function from(row: typeof SessionResultTable.$inferSelect): Info {
    return {
      id: row.id,
      carrier: row.carrier,
      status: row.status,
      satisfying: row.satisfying,
      session_id: row.session_id,
      parent_session_id: row.parent_session_id ?? undefined,
      child_session_id: row.child_session_id ?? undefined,
      run_id: row.run_id ?? undefined,
      action_id: row.action_id ?? undefined,
      target_action_id: row.target_action_id ?? undefined,
      raw_ref: row.raw_ref,
      summary: row.summary ?? undefined,
      created_at: row.created_at,
    }
  }

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function text(input: unknown) {
    if (typeof input === "string") return input
  }

  function number(input: unknown) {
    if (typeof input === "number" && Number.isFinite(input)) return input
  }
}
