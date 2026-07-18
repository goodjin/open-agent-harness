import { Instance } from "@/project/instance"
import { and, desc, eq, inArray } from "@/storage/db"
import { Database } from "@/storage/db"
import { MessageTable, PartTable, SessionLogTable, SessionTable } from "./session.sql"
import { Session } from "."
import { SessionLog } from "./log"
import { MessageV2 } from "./message-v2"
import { SessionStatus } from "./status"
import type { MessageID, PartID, SessionID } from "./schema"
import { SessionTaskRecovery } from "./task-recovery"
import { SessionTaskHandoff } from "./task-handoff"

export namespace SessionRecovery {
  const error = "Tool call interrupted by process restart before finish/error was recorded."

  export type Risk = "low" | "medium" | "high"

  export type Tool = {
    part_id: PartID
    message_id: MessageID
    call_id: string
    tool: string
    status: "pending" | "running"
    input: Record<string, unknown>
    started_at?: number
    last_seen_at: number
    logs: string[]
    risk: Risk
    recovery_hint: string
  }

  export type Packet = {
    session_id: SessionID
    parent_session_id?: SessionID
    title: string
    updated_at: number
    status: "stale_interrupted"
    parent?: Record<string, unknown>
    tools: Tool[]
  }

  export async function detect(input?: { directory?: string; limit?: number }) {
    const dir = input?.directory ?? Instance.directory
    const sessions = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, Instance.project.id), eq(SessionTable.directory, dir)))
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(input?.limit ?? 500)
        .all(),
    )
    const ids = sessions.map((item) => item.id)
    if (ids.length === 0) return []

    const rows = Database.use((db) =>
      db
        .select({
          id: PartTable.id,
          session_id: PartTable.session_id,
          message_id: PartTable.message_id,
          time_created: PartTable.time_created,
          time_updated: PartTable.time_updated,
          data: PartTable.data,
        })
        .from(PartTable)
        .innerJoin(MessageTable, and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)))
        .where(inArray(PartTable.session_id, ids))
        .all(),
    )
    const logs = Database.use((db) =>
      db
        .select()
        .from(SessionLogTable)
        .where(inArray(SessionLogTable.session_id, ids))
        .orderBy(desc(SessionLogTable.time_created), desc(SessionLogTable.id))
        .limit(5000)
        .all(),
    )
    const bySession = new Map(sessions.map((item) => [item.id, Session.fromRow(item)]))
    const byLog = Map.groupBy(
      logs.map((item) => ({
        partID: item.part_id,
        sessionID: item.session_id,
        type: item.type,
        time: item.time_created,
        data: item.data,
      })),
      (item) => item.sessionID,
    )
    const packets = new Map<SessionID, Packet>()

    for (const row of rows) {
      const part = {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as MessageV2.Part
      if (part.type !== "tool") continue
      if (part.state.status !== "pending" && part.state.status !== "running") continue
      const status = SessionStatus.get(row.session_id).type
      if (status !== "idle" && status !== "interrupted") continue

      const session = bySession.get(row.session_id)
      if (!session) continue

      const logs = (byLog.get(row.session_id) ?? [])
        .filter((item) => item.partID === row.id || item.time >= start(part.state, row.time_created))
        .slice(0, 20)
        .toReversed()
      const risk = assess(part.tool, part.state.input)
      const tool = {
        part_id: row.id,
        message_id: row.message_id,
        call_id: part.callID,
        tool: part.tool,
        status: part.state.status,
        input: part.state.input,
        started_at: part.state.status === "running" ? part.state.time.start : row.time_created,
        last_seen_at: Math.max(row.time_updated, ...logs.map((item) => item.time), row.time_created),
        logs: logs.map((item) => item.type),
        risk,
        recovery_hint: hint(risk),
      } satisfies Tool
      const packet = packets.get(row.session_id) ?? {
        session_id: session.id,
        parent_session_id: session.parentID,
        title: session.title,
        updated_at: session.time.updated,
        status: "stale_interrupted" as const,
        parent: parent(session.dsl_context),
        tools: [],
      }
      packet.tools.push(tool)
      packets.set(row.session_id, packet)
    }

    return [...packets.values()]
  }

  export async function mark(input?: { directory?: string; limit?: number }) {
    await SessionTaskRecovery.scan()
    await SessionTaskHandoff.scan()
    const packets = await detect(input)
    const now = Date.now()
    for (const packet of packets) {
      await SessionLog.emit({
        sessionID: packet.session_id,
        level: "warn",
        type: "session.recovery.detected",
        data: packet,
        time: now,
      })
      for (const tool of packet.tools) {
        const part = (await MessageV2.parts(tool.message_id)).find((item) => item.id === tool.part_id)
        if (!part) continue
        if (part.type !== "tool") continue
        if (part.state.status !== "pending" && part.state.status !== "running") continue
        await Session.updatePart({
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error,
            metadata: {
              ...(part.state.status === "running" ? part.state.metadata : undefined),
              recovery: {
                status: "stale_interrupted",
                risk: tool.risk,
                hint: tool.recovery_hint,
                detected_at: now,
                last_seen_at: tool.last_seen_at,
              },
            },
            time: {
              start: tool.started_at ?? now,
              end: now,
            },
          },
        })
        await SessionLog.emit({
          sessionID: packet.session_id,
          messageID: tool.message_id,
          partID: tool.part_id,
          level: "warn",
          type: "session.recovery.tool_marked_stale",
          data: tool,
          time: now,
        })
      }
    }
    return packets
  }

  export async function marked(input?: { directory?: string }) {
    const dir = input?.directory ?? Instance.directory
    const sessions = Database.use((db) =>
      db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, dir),
            eq(SessionTable.status_class, "interrupted"),
          ),
        )
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .all(),
    )
    const ids = sessions.map((item) => item.id)
    if (ids.length === 0) return []
    const rows = Database.use((db) =>
      db
        .select({ session_id: PartTable.session_id, data: PartTable.data })
        .from(PartTable)
        .where(inArray(PartTable.session_id, ids))
        .all(),
    )
    return [
      ...new Set(
        rows
          .filter((row) => {
            const part = row.data as MessageV2.Part
            if (part.type !== "tool") return false
            if (part.state.status !== "error") return false
            return object(object(part.state.metadata)?.recovery)?.status === "stale_interrupted"
          })
          .map((row) => row.session_id),
      ),
    ]
  }

  function start(state: MessageV2.ToolPart["state"], fallback: number) {
    if (state.status !== "running") return fallback
    return state.time.start
  }

  function assess(tool: string, input: Record<string, unknown>): Risk {
    if (tool !== "bash") return "medium"
    const cmd = typeof input.command === "string" ? input.command : ""
    if (/\b(git\s+push|npm\s+publish|pnpm\s+publish|bun\s+publish)\b/.test(cmd)) return "high"
    if (/\b(rm\s+-|deploy|curl\b.*\b-X\s*(POST|PUT|PATCH|DELETE))\b/.test(cmd)) return "high"
    if (/\b(test|vitest|typecheck|build|lint|git\s+(status|rev-parse|ls-remote|diff|show))\b/.test(cmd)) return "low"
    return "medium"
  }

  function hint(risk: Risk) {
    if (risk === "high") return "requires_user_confirmation"
    if (risk === "low") return "safe_to_review_or_rerun"
    return "review_before_rerun"
  }

  function parent(input: unknown) {
    const data = object(input)
    const protocol = object(data?.protocol)
    const delegation = object(protocol?.delegation)
    if (!delegation) return undefined
    return delegation
  }

  function object(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
    return input as Record<string, unknown>
  }
}
