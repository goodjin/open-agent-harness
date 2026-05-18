import { BusEvent } from "@/bus/bus-event"
import { and, asc, eq, gt, lt, or } from "@/storage/db"
import { Database } from "@/storage/db"
import { Identifier } from "@/id/id"
import { z } from "zod"
import { Bus } from "@/bus"
import { SessionLogTable } from "./session.sql"
import { MessageID, PartID, SessionID } from "./schema"

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

  const state = {
    cleanup: 0,
  }

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
}
