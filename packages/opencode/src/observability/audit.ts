import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { WorkspaceID } from "@/control-plane/schema"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import z from "zod"

export namespace Audit {
  const DEFAULT = 50
  const MAX = 200

  export const EventType = z
    .enum([
      "permission.asked",
      "permission.replied",
      "restore.completed",
      "workflow.started",
      "workflow.paused",
      "workflow.completed",
      "workflow.failed",
      "memory.captured",
      "memory.failed",
    ])
    .meta({
      ref: "AuditEventType",
    })
  export type EventType = z.infer<typeof EventType>

  export const PatternKind = z.enum(["command", "path", "secret", "url", "wildcard", "literal"])
  export type PatternKind = z.infer<typeof PatternKind>
  export const PatternSummary = z.object({
    patternCount: z.number().int().nonnegative(),
    patternHash: z.string(),
    patternKinds: PatternKind.array(),
  })
  export type PatternSummary = z.infer<typeof PatternSummary>

  export const Detail = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("permission.asked"),
        requestID: z.string(),
        permission: z.string(),
        ...PatternSummary.shape,
      }),
      z.object({
        type: z.literal("permission.replied"),
        requestID: z.string(),
        reply: z.enum(["once", "always", "reject"]),
        feedback: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("restore.completed"),
        hash: z.string(),
      }),
      z.object({
        type: z.literal("workflow.started"),
        workflowID: z.string(),
        runID: z.string(),
      }),
      z.object({
        type: z.literal("workflow.paused"),
        workflowID: z.string(),
        runID: z.string(),
        status: z.enum(["waiting_user", "waiting_permission"]),
        step: z.string(),
      }),
      z.object({
        type: z.literal("workflow.completed"),
        workflowID: z.string(),
        runID: z.string(),
      }),
      z.object({
        type: z.literal("workflow.failed"),
        workflowID: z.string(),
        runID: z.string(),
        step: z.string().optional(),
      }),
      z.object({
        type: z.literal("memory.captured"),
        count: z.number().int().nonnegative(),
      }),
      z.object({
        type: z.literal("memory.failed"),
        reason: z.string(),
      }),
    ])
    .meta({
      ref: "AuditEvent",
    })
  export type Detail = z.infer<typeof Detail>

  export const Record = z
    .object({
      id: z.string(),
      time: z.number().int().nonnegative(),
      projectID: ProjectID.zod,
      workspaceID: WorkspaceID.zod.optional(),
      sessionID: SessionID.zod.optional(),
      event: Detail,
    })
    .meta({
      ref: "AuditRecord",
    })
  export type Record = z.infer<typeof Record>

  export const Query = z.object({
    sessionID: SessionID.zod.optional(),
    projectID: ProjectID.zod.optional(),
    eventType: EventType.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX).default(DEFAULT),
  })
  export type Query = z.infer<typeof Query>
  export type QueryInput = z.input<typeof Query>

  type Asked = Extract<Detail, { type: "permission.asked" }>
  type AskedInput = Omit<Asked, "patternCount" | "patternHash" | "patternKinds"> & {
    patterns: string[]
  }
  export type EmitDetail = Exclude<Detail, Asked> | Asked | AskedInput
  type Stored = Record & { directory: string }

  export const Event = {
    Recorded: BusEvent.define("observability.audit.recorded", Record),
  }

  const state = Instance.state(() => {
    const records: Stored[] = []
    return { records }
  })

  function id() {
    return `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }

  function hash(patterns: string[]) {
    return new Bun.CryptoHasher("sha256").update(patterns.join("\0")).digest("hex")
  }

  function redact(input: string) {
    return input
      .replace(/authorization\s*:\s*(bearer|basic)?\s*[^\s,;]+/gi, "Authorization: [redacted]")
      .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/sk-[a-z0-9_-]{8,}/gi, "sk-[redacted]")
      .replace(/([?&](?:access_token|api_key|apikey|auth|authorization|key|token)=)[^&#\s]+/gi, "$1[redacted]")
  }

  function kind(pattern: string): PatternKind {
    const text = pattern.toLowerCase()
    if (/authorization\s*:|bearer\s+|sk-[a-z0-9_-]{8,}|[?&](access_token|api_key|apikey|auth|authorization|key|token)=/i.test(pattern))
      return "secret"
    if (/https?:\/\//.test(text)) return "url"
    if (pattern.includes("*")) return "wildcard"
    if (pattern.startsWith("/") || pattern.startsWith("~/") || pattern.includes("\\") || pattern.includes("../"))
      return "path"
    if (/\s/.test(pattern)) return "command"
    return "literal"
  }

  export function summarize(patterns: string[]): PatternSummary {
    return {
      patternCount: patterns.length,
      patternHash: hash(patterns),
      patternKinds: Array.from(new Set(patterns.map(kind))).sort(),
    }
  }

  function publicize(record: Stored): Record {
    return {
      id: record.id,
      time: record.time,
      projectID: record.projectID,
      workspaceID: record.workspaceID,
      sessionID: record.sessionID,
      event: record.event,
    }
  }

  function sanitize(event: EmitDetail): Detail {
    if (event.type === "permission.asked") {
      if ("patterns" in event) {
        return {
          type: "permission.asked",
          requestID: redact(event.requestID),
          permission: redact(event.permission),
          ...summarize(event.patterns),
        }
      }
      return {
        ...event,
        requestID: redact(event.requestID),
        permission: redact(event.permission),
      }
    }
    if (event.type === "workflow.paused") return { ...event, step: redact(event.step) }
    if (event.type === "workflow.failed" && event.step) return { ...event, step: redact(event.step) }
    if (event.type === "memory.failed") return { ...event, reason: redact(event.reason) }
    return event
  }

  function visible(record: Stored, query: Query) {
    if (record.directory !== Instance.directory) return false
    if (query.projectID && record.projectID !== query.projectID) return false
    if (query.sessionID && record.sessionID !== query.sessionID) return false
    if (query.eventType && record.event.type !== query.eventType) return false
    return true
  }

  export async function emit(input: {
    sessionID?: SessionID
    workspaceID?: WorkspaceID
    event: EmitDetail
  }) {
    const record: Stored = {
      id: id(),
      time: Date.now(),
      directory: Instance.directory,
      projectID: Instance.project.id,
      workspaceID: input.workspaceID,
      sessionID: input.sessionID,
      event: sanitize(input.event),
    }
    state().records.push(record)
    const output = publicize(record)
    await Bus.publish(Event.Recorded, output)
    return output
  }

  export function query(input: QueryInput = {}) {
    const query = Query.parse(input)
    const records = state()
      .records.filter((record) => visible(record, query))
      .sort((a, b) => a.time - b.time)
    const index = query.cursor ? records.findIndex((record) => record.id === query.cursor) : -1
    return records.slice(index >= 0 ? index + 1 : 0, (index >= 0 ? index + 1 : 0) + query.limit).map(publicize)
  }

  export function clear() {
    state().records.splice(0)
  }
}
