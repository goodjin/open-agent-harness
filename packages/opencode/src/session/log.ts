import { BusEvent } from "@/bus/bus-event"
import { and, asc, eq, gt, lt, or } from "@/storage/db"
import { Database } from "@/storage/db"
import { Identifier } from "@/id/id"
import { z } from "zod"
import { Bus } from "@/bus"
import { SessionLogTable } from "./session.sql"
import { MessageID, PartID, SessionID } from "./schema"
import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { createHash } from "crypto"

export namespace SessionLog {
  export const retention = 7 * 24 * 60 * 60 * 1000

  export const Level = z.enum(["debug", "info", "warn", "error"])

  export const Info = z.object({
    id: z.string(),
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    partID: PartID.zod.optional(),
    level: Level,
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
    time: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export const Payload = z.object({
    id: Identifier.schema("payload"),
    sessionID: SessionID.zod,
    data: z.unknown(),
    time: z.number(),
    bytes: z.number(),
  })
  export type Payload = z.infer<typeof Payload>

  export const Chunk = z.object({
    id: z.string().startsWith("chunk_"),
    sessionID: SessionID.zod,
    kind: z.string(),
    format: z.enum(["markdown", "json", "text", "raw"]),
    title: z.string().optional(),
    hash: z.string(),
    data: z.unknown(),
    bytes: z.number(),
    time: z.number(),
  })
  export type Chunk = z.infer<typeof Chunk>

  export const Manifest = z.object({
    id: Identifier.schema("payload"),
    version: z.literal(2),
    kind: z.string(),
    sessionID: SessionID.zod,
    time: z.number(),
    meta: z.record(z.string(), z.unknown()).optional(),
    sections: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        chunks: z.array(z.string().startsWith("chunk_")),
      }),
    ),
  })
  export type Manifest = z.infer<typeof Manifest>

  export const ManifestInput = z.object({
    id: Identifier.schema("payload"),
    sessionID: SessionID.zod,
    kind: z.string(),
    time: z.number().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    sections: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        chunks: z.array(
          z.object({
            kind: z.string(),
            format: z.enum(["markdown", "json", "text", "raw"]),
            title: z.string().optional(),
            data: z.unknown(),
          }),
        ),
      }),
    ),
  })
  export type ManifestInput = z.infer<typeof ManifestInput>

  export const Event = {
    Created: BusEvent.define("session.log.created", z.object({ info: Info })),
  }

  export const Emit = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    partID: PartID.zod.optional(),
    level: Level,
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
    time: z.number().optional(),
  })
  export type Emit = z.infer<typeof Emit>

  export const List = z.object({
    sessionID: SessionID.zod,
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  export type List = z.infer<typeof List>

  export const ProtocolTrace = z.object({
    session_id: z.string(),
    run_id: z.string(),
    type: z.literal("agent.protocol.trace"),
    version: z.literal("1"),
    declaration: z.unknown().optional(),
    result: z.unknown().optional(),
    actions: z.array(z.record(z.string(), z.unknown())),
    tool_calls: z.array(z.record(z.string(), z.unknown())),
    metrics: z.object({
      actions: z.number(),
      internal_tool_calls: z.number(),
      direct_model_tool_calls: z.number(),
      model_visible_bytes: z.number(),
      raw_output_bytes: z.number(),
      duration_ms: z.number(),
    }),
  })
  export type ProtocolTrace = z.infer<typeof ProtocolTrace>

  const state = {
    cleanup: 0,
  }
  const dir = path.join(Global.Path.data, "session-log-payload")

  export async function emit(input: Emit) {
    const row = Database.use((tx) =>
      tx
        .insert(SessionLogTable)
        .values({
          id: Identifier.ascending("log"),
          session_id: input.sessionID,
          message_id: input.messageID,
          part_id: input.partID,
          level: input.level,
          type: input.type,
          data: input.data,
          time_created: input.time ?? Date.now(),
        })
        .returning()
        .get(),
    )
    const info = parse(row)
    Bus.publish(Event.Created, { info })
    if (info.time - state.cleanup > 60 * 60 * 1000) {
      state.cleanup = info.time
      await cleanup(info.time)
    }
    return info
  }

  export async function list(input: List) {
    const rows = Database.use((tx) => {
      const mark = input.cursor
        ? tx
            .select()
            .from(SessionLogTable)
            .where(and(eq(SessionLogTable.session_id, input.sessionID), eq(SessionLogTable.id, input.cursor)))
            .get()
        : undefined
      return tx
        .select()
        .from(SessionLogTable)
        .where(
          mark
            ? and(
                eq(SessionLogTable.session_id, input.sessionID),
                or(
                  gt(SessionLogTable.time_created, mark.time_created),
                  and(eq(SessionLogTable.time_created, mark.time_created), gt(SessionLogTable.id, mark.id)),
                ),
              )
            : eq(SessionLogTable.session_id, input.sessionID),
        )
        .orderBy(asc(SessionLogTable.time_created), asc(SessionLogTable.id))
        .limit(input.limit ?? 1000)
        .all()
    })
    return rows.map(parse)
  }

  export async function cleanup(now = Date.now()) {
    Database.use((tx) =>
      tx.delete(SessionLogTable).where(lt(SessionLogTable.time_created, now - retention)).run(),
    )
    const cutoff = now - retention
    const entries = await Array.fromAsync(new Bun.Glob("payload_*").scan({ cwd: dir, onlyFiles: true })).catch(
      () => [] as string[],
    )
    for (const entry of entries) {
      if (Identifier.timestamp(entry) >= cutoff) continue
      await Bun.file(path.join(dir, entry)).delete().catch(() => {})
    }
    const chunks = await Array.fromAsync(new Bun.Glob("*/chunk_*").scan({ cwd: dir, onlyFiles: true })).catch(
      () => [] as string[],
    )
    for (const entry of chunks) {
      const file = path.join(dir, entry)
      const chunk = await Filesystem.readJson(file)
        .then((data) => Chunk.parse(data))
        .catch(() => undefined)
      if (chunk && chunk.time >= cutoff) continue
      await Bun.file(file).delete().catch(() => {})
    }
  }

  export async function remove(input: { sessionID: SessionID; now?: number }) {
    Database.use((tx) =>
      tx
        .delete(SessionLogTable)
        .where(
          and(
            eq(SessionLogTable.session_id, input.sessionID),
            lt(SessionLogTable.time_created, (input.now ?? Date.now()) - retention),
          ),
        )
        .run(),
    )
  }

  export async function protocolTrace(input: { sessionID: SessionID; runID: string }) {
    const logs = await list({ sessionID: input.sessionID, limit: 5000 })
    const records = logs.filter((item) => item.type.startsWith("protocol.") && item.data.runID === input.runID)
    if (records.length === 0) return undefined

    const actions: Record<string, unknown>[] = records
      .filter((item) => item.type.startsWith("protocol.action."))
      .map((item) => ({ type: item.type, time: item.time, ...item.data }))
    const tools = records
      .filter((item) => item.type === "protocol.action.tool_call")
      .map((item) => ({
        call_id: item.data.callID,
        tool: item.data.tool,
        status: item.data.status ?? "completed",
        output_bytes: typeof item.data.outputBytes === "number" ? item.data.outputBytes : 0,
      }))
    const done = records.find((item) => item.type === "protocol.completed" || item.type === "protocol.failed")
    const metrics = object(done?.data.metrics)
    const raw = tools.reduce((sum, item) => sum + (typeof item.output_bytes === "number" ? item.output_bytes : 0), 0)

    return {
      session_id: input.sessionID,
      run_id: input.runID,
      type: "agent.protocol.trace" as const,
      version: "1" as const,
      declaration: records.find((item) => item.type === "protocol.validated")?.data.declaration,
      result: done?.data.result,
      actions,
      tool_calls: tools,
      metrics: {
        actions: new Set(actions.map((item) => item.actionID).filter((item) => typeof item === "string")).size,
        internal_tool_calls: tools.length,
        direct_model_tool_calls: 0,
        model_visible_bytes: typeof metrics?.modelVisibleBytes === "number" ? metrics.modelVisibleBytes : 0,
        raw_output_bytes: raw,
        duration_ms: typeof metrics?.durationMs === "number" ? metrics.durationMs : 0,
      },
    } satisfies ProtocolTrace
  }

  export function payloadID() {
    return Identifier.ascending("payload")
  }

  export async function savePayload(input: { id: string; sessionID: SessionID; data: unknown; time?: number }) {
    const text = JSON.stringify(
      {
        id: input.id,
        sessionID: input.sessionID,
        data: input.data,
        time: input.time ?? Date.now(),
      },
      replacer(),
      2,
    )
    await Filesystem.write(path.join(dir, input.id), text)
    return {
      id: input.id,
      bytes: Buffer.byteLength(text, "utf8"),
    }
  }

  export async function savePayloadManifest(input: ManifestInput) {
    const at = input.time ?? Date.now()
    const sections = []
    for (const section of input.sections) {
      const chunks = []
      for (const item of section.chunks) {
        chunks.push((await saveChunk({ ...item, sessionID: input.sessionID, time: at })).id)
      }
      sections.push({
        id: section.id,
        label: section.label,
        chunks,
      })
    }
    const data = {
      id: input.id,
      version: 2,
      kind: input.kind,
      sessionID: input.sessionID,
      time: at,
      meta: input.meta,
      sections,
    } satisfies Manifest
    const text = JSON.stringify(data, replacer(), 2)
    await Filesystem.write(path.join(dir, input.id), text)
    return {
      id: input.id,
      bytes: Buffer.byteLength(text, "utf8"),
    }
  }

  export async function readPayload(input: { id: string; sessionID: SessionID }) {
    const raw = await Filesystem.readJson(path.join(dir, input.id)).catch(() => undefined)
    const manifest = Manifest.safeParse(raw)
    if (manifest.success) {
      if (manifest.data.sessionID !== input.sessionID) return undefined
      return {
        id: manifest.data.id,
        sessionID: manifest.data.sessionID,
        data: await hydrate(manifest.data),
        time: manifest.data.time,
        bytes: await Filesystem.size(path.join(dir, input.id)),
      } satisfies Payload
    }
    const parsed = await Promise.resolve(raw)
      .then((data) => Payload.omit({ bytes: true }).parse(data))
      .catch(() => undefined)
    if (!parsed) return undefined
    if (parsed.sessionID !== input.sessionID) return undefined
    return {
      ...parsed,
      bytes: await Filesystem.size(path.join(dir, input.id)),
    } satisfies Payload
  }

  function parse(row: typeof SessionLogTable.$inferSelect): Info {
    return {
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id ?? undefined,
      partID: row.part_id ?? undefined,
      level: Level.parse(row.level),
      type: row.type,
      data: row.data,
      time: row.time_created,
    }
  }

  function object(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
    return input as Record<string, unknown>
  }

  async function saveChunk(input: Omit<Chunk, "id" | "hash" | "bytes">) {
    const body = stable({
      sessionID: input.sessionID,
      kind: input.kind,
      format: input.format,
      title: input.title,
      data: input.data,
    })
    const hash = createHash("sha256").update(body).digest("hex")
    const id = `chunk_${hash}`
    const file = path.join(dir, input.sessionID, id)
    const found = await Filesystem.readJson(file)
      .then((data) => Chunk.parse(data))
      .catch(() => undefined)
    if (found) return found
    const data = {
      id,
      sessionID: input.sessionID,
      kind: input.kind,
      format: input.format,
      title: input.title,
      hash,
      data: input.data,
      bytes: Buffer.byteLength(body, "utf8"),
      time: input.time,
    } satisfies Chunk
    await Filesystem.write(file, JSON.stringify(data, replacer(), 2))
    return data
  }

  async function hydrate(input: Manifest) {
    const sections = []
    for (const section of input.sections) {
      sections.push({
        ...section,
        chunks: (
          await Promise.all(
            section.chunks.map((id) =>
              Filesystem.readJson(path.join(dir, input.sessionID, id))
                .then((data) => Chunk.parse(data))
                .catch(() => ({
                  id,
                  sessionID: input.sessionID,
                  kind: "missing",
                  format: "raw" as const,
                  title: "Missing chunk",
                  hash: id.replace(/^chunk_/, ""),
                  data: { missing: id },
                  bytes: 0,
                  time: input.time,
                })),
            ),
          )
        ).filter((item) => item.sessionID === input.sessionID),
      })
    }
    return {
      ...input,
      sections,
    }
  }

  function stable(input: unknown): string {
    if (input === null) return "null"
    if (typeof input === "bigint") return JSON.stringify(input.toString())
    if (typeof input !== "object") return JSON.stringify(input)
    if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`
    const obj = input as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`)
      .join(",")}}`
  }

  function replacer() {
    const seen = new WeakSet<object>()
    return (_: string, value: unknown) => {
      if (typeof value === "function") return `[function ${value.name || "anonymous"}]`
      if (typeof value === "bigint") return value.toString()
      if (!value || typeof value !== "object") return value
      if (seen.has(value)) return "[Circular]"
      seen.add(value)
      return value
    }
  }
}
