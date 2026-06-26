import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Metrics } from "@/observability/metrics"
import { SessionID } from "./schema"
import { Storage } from "@/storage/storage"
import z from "zod"
import { SessionLog } from "./log"
import { and, Database, eq } from "@/storage/db"
import { SessionTable } from "./session.sql"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("running"),
      }),
      z.object({
        type: z.literal("queued"),
      }),
      z.object({
        type: z.literal("starting"),
      }),
      z.object({
        type: z.literal("rate_limited"),
        providerID: z.string(),
        modelID: z.string(),
        scope: z.enum(["provider", "model", "agent"]),
        kind: z.enum(["concurrency", "rpm"]).optional(),
        agent: z.string().optional(),
        active: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        queued: z.number().int().positive(),
        reset: z.number().int().positive().optional(),
      }),
      z.object({
        type: z.literal("waiting_permission"),
      }),
      z.object({
        type: z.literal("waiting_user"),
      }),
      z.object({
        type: z.literal("waiting_child"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("error"),
        message: z.string(),
        reason: z.enum(["output_safety"]).optional(),
        recoverable: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("timeout"),
        message: z.string(),
      }),
      z.object({
        type: z.literal("paused"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("aborting"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("aborted"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("failed"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("blocked"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("interrupted"),
        message: z.string().optional(),
        prior: z
          .enum(["queued", "starting", "running", "rate_limited", "retry"])
          .optional(),
      }),
      z.object({
        type: z.literal("completed"),
      }),
      z.object({
        type: z.literal("terminal_reply"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("user_completed"),
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal("archived"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>
  export class InvalidTransitionError extends Error {
    constructor(from: Info["type"], to: Info["type"]) {
      super(`Invalid session status transition: ${from} -> ${to}`)
      this.name = "InvalidTransitionError"
    }
  }

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const state = Instance.state(() => {
    const data: Record<string, Info> = {}
    return data
  })

  const writes = Instance.state(() => new Set<Promise<void>>())
  const chains = Instance.state(() => new Map<SessionID, Promise<void>>())

  type Saved = {
    sessionID: SessionID
    projectID: string
    directory: string
    status: Info
    time: number
  }
  type Class = "active" | "blocked" | "interrupted" | "terminal" | "archived"
  type Source = "runtime" | "recovery" | "user" | "system"
  type Row = typeof SessionTable.$inferSelect

  const transitions: Record<Info["type"], Info["type"][]> = {
    idle: [
      "idle",
      "queued",
      "starting",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "paused",
      "aborting",
      "aborted",
      "failed",
      "blocked",
      "interrupted",
      "completed",
      "terminal_reply",
      "user_completed",
      "archived",
    ],
    queued: [
      "idle",
      "starting",
      "running",
      "waiting_child",
      "aborted",
      "failed",
      "blocked",
      "interrupted",
      "terminal_reply",
      "user_completed",
    ],
    starting: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "retry",
      "aborted",
      "failed",
      "blocked",
      "interrupted",
      "terminal_reply",
      "user_completed",
    ],
    running: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "retry",
      "paused",
      "aborting",
      "aborted",
      "failed",
      "blocked",
      "interrupted",
      "completed",
      "terminal_reply",
      "user_completed",
    ],
    rate_limited: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "retry",
      "paused",
      "aborting",
      "aborted",
      "failed",
      "blocked",
      "interrupted",
      "terminal_reply",
      "user_completed",
    ],
    waiting_permission: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "paused",
      "aborting",
      "aborted",
      "failed",
      "blocked",
      "terminal_reply",
      "user_completed",
    ],
    waiting_user: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "paused",
      "aborting",
      "aborted",
      "failed",
      "blocked",
      "terminal_reply",
      "user_completed",
    ],
    waiting_child: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "paused",
      "aborting",
      "aborted",
      "failed",
      "blocked",
      "interrupted",
      "completed",
      "terminal_reply",
      "user_completed",
    ],
    error: [
      "idle",
      "running",
      "rate_limited",
      "waiting_child",
      "error",
      "timeout",
      "aborted",
      "failed",
      "blocked",
      "terminal_reply",
      "user_completed",
      "archived",
    ],
    timeout: [
      "idle",
      "running",
      "rate_limited",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "error",
      "timeout",
      "aborted",
      "failed",
      "blocked",
      "terminal_reply",
      "user_completed",
      "archived",
    ],
    retry: [
      "idle",
      "running",
      "rate_limited",
      "waiting_child",
      "error",
      "timeout",
      "retry",
      "paused",
      "aborted",
      "failed",
      "blocked",
      "terminal_reply",
      "user_completed",
    ],
    paused: ["idle", "running", "waiting_child", "aborting", "aborted", "failed", "blocked", "terminal_reply", "user_completed"],
    aborting: ["idle", "aborted", "failed"],
    aborted: ["idle", "running", "waiting_child", "aborted", "terminal_reply", "user_completed", "archived"],
    failed: ["idle", "running", "waiting_child", "failed", "terminal_reply", "user_completed", "archived"],
    blocked: [
      "idle",
      "running",
      "waiting_permission",
      "waiting_user",
      "waiting_child",
      "aborted",
      "failed",
      "blocked",
      "terminal_reply",
      "user_completed",
    ],
    interrupted: ["idle", "running", "waiting_child", "aborted", "failed", "blocked", "terminal_reply", "user_completed", "archived"],
    completed: ["idle", "running", "rate_limited", "waiting_child", "completed", "terminal_reply", "user_completed", "archived"],
    terminal_reply: ["idle", "running", "waiting_child", "terminal_reply", "completed", "user_completed", "archived"],
    user_completed: ["idle", "running", "waiting_child", "user_completed", "archived"],
    archived: ["idle", "archived"],
  }

  type Restart = Extract<Info, { type: "starting" | "running" }>
  const restart = new Set<Restart["type"]>(["starting", "running"])
  const lost = (status: Info): status is Restart => restart.has(status.type as Restart["type"])

  export function get(sessionID: SessionID) {
    const cached = state()[sessionID]
    if (cached) return cached
    const status = load(sessionID)
    if (!status || status.type === "idle") return { type: "idle" as const }
    state()[sessionID] = status
    return status
  }

  export function list() {
    return state()
  }

  export function shouldContinue(status: Info) {
    return (
      status.type === "running" ||
      status.type === "queued" ||
      status.type === "starting" ||
      status.type === "rate_limited" ||
      status.type === "retry"
    )
  }

  function save(sessionID: SessionID, status: Info) {
    const prior = chains().get(sessionID) ?? Promise.resolve()
    const project = Instance.project.id
    const directory = Instance.directory
    const run = prior
      .then(() => {
        persist(sessionID, status, "runtime")
        return status.type === "idle" || status.type === "archived"
          ? Storage.remove(["session_status", sessionID])
          : Storage.write(["session_status", sessionID], {
              sessionID,
              projectID: project,
              directory,
              status,
              time: Date.now(),
            } satisfies Saved)
      })
      .catch(() => {})
      .finally(() => {
        writes().delete(run)
        if (chains().get(sessionID) === run) chains().delete(sessionID)
      })
    chains().set(sessionID, run)
    writes().add(run)
  }

  export async function flush() {
    const pending = Array.from(writes())
    await Promise.all(pending)
  }

  export async function restore() {
    await flush()
    const data = state()
    const rows = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, Instance.project.id), eq(SessionTable.directory, Instance.directory)))
        .all(),
    )
    const keys = await Storage.list(["session_status"])
    const out: Record<string, Info> = {}
    const seen = new Set<SessionID>()
    for (const row of rows) {
      seen.add(row.id)
      const parsed = decode(row)
      if (!parsed || parsed.type === "idle") continue
      const status = lost(parsed)
        ? ({
            type: "interrupted",
            prior: parsed.type,
            message: `Session was ${parsed.type} when the process stopped.`,
          } satisfies Info)
        : parsed
      data[row.id] = status
      out[row.id] = status
      if (changed(status, parsed)) persist(row.id, status, "recovery")
    }
    for (const key of keys) {
      const item = await Storage.read<Saved>(key).catch(() => undefined)
      if (!item) continue
      if (seen.has(item.sessionID)) continue
      if (item.projectID !== Instance.project.id) continue
      if (item.directory !== Instance.directory) continue
      const parsed = Info.safeParse(item.status)
      if (!parsed.success) continue
      if (parsed.data.type === "idle") continue
      const status = lost(parsed.data)
        ? ({
            type: "interrupted",
            prior: parsed.data.type,
            message: `Session was ${parsed.data.type} when the process stopped.`,
          } satisfies Info)
        : parsed.data
      data[item.sessionID] = status
      out[item.sessionID] = status
      if (status !== parsed.data) save(item.sessionID, status)
    }
    return out
  }

  function reason(status: Info) {
    if ("message" in status && status.message) return status.message
    if (status.type === "rate_limited") {
      return `Waiting for ${status.scope} concurrency slot ${status.providerID}/${status.modelID}.`
    }
    if (status.type === "retry") return status.message
    if (status.type === "interrupted" && status.prior) return `Process stopped while ${status.prior}.`
    if (status.type === "terminal_reply") return status.message ?? "Delegated child returned a reply."
    return `Session status changed to ${status.type}.`
  }

  function changed(a: Info, b: Info) {
    return JSON.stringify(a) !== JSON.stringify(b)
  }

  function record(sessionID: SessionID, from: Info, to: Info, why?: string) {
    void SessionLog.emit({
      sessionID,
      level: to.type === "error" || to.type === "timeout" || to.type === "failed" ? "warn" : "info",
      type: "session.status.changed",
      data: {
        from: from.type,
        to: to.type,
        reason: why ?? reason(to),
        fromStatus: from,
        toStatus: to,
      },
    }).catch(() => {})
  }

  export function set(sessionID: SessionID, status: Info, opts?: { reason?: string }) {
    const current = get(sessionID)
    if (!transitions[current.type].includes(status.type)) {
      throw new InvalidTransitionError(current.type, status.type)
    }
    const diff = changed(current, status)
    Metrics.emit("opencode_session_lifecycle_total", {
      event: "status",
      status: status.type,
    })
    Bus.publish(Event.Status, {
      sessionID,
      status,
    })
    if (status.type === "idle") {
      // deprecated
      Bus.publish(Event.Idle, {
        sessionID,
      })
      delete state()[sessionID]
      save(sessionID, status)
      if (diff) record(sessionID, current, status, opts?.reason)
      return
    }
    state()[sessionID] = status
    save(sessionID, status)
    if (diff) record(sessionID, current, status, opts?.reason)
  }

  export function dismiss(sessionID: SessionID) {
    const current = get(sessionID)
    if (current.type !== "error" && current.type !== "timeout") return current
    set(sessionID, { type: "idle" })
    return get(sessionID)
  }

  function load(sessionID: SessionID) {
    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
    if (!row) return
    if (row.project_id !== Instance.project.id) return
    if (row.directory !== Instance.directory) return
    return decode(row)
  }

  function persist(sessionID: SessionID, status: Info, source: Source) {
    const row = encode(status, source)
    Database.use((db) => {
      db.update(SessionTable).set(row).where(eq(SessionTable.id, sessionID)).run()
    })
  }

  function encode(status: Info, source: Source) {
    const now = Date.now()
    const message = "message" in status ? status.message : undefined
    const base = {
      status_message: message ?? null,
      status_recoverable: recoverable(status),
      status_updated_at: now,
      status_source: source,
      status_detail: detail(status),
    }
    if (status.type === "idle") return { ...base, status_class: "active" as Class, status: "idle" }
    if (status.type === "queued" || status.type === "starting" || status.type === "running")
      return { ...base, status_class: "active" as Class, status: status.type }
    if (status.type === "rate_limited")
      return {
        ...base,
        status_class: "blocked" as Class,
        status: status.kind === "rpm" ? "blocked_rate_limit" : "blocked_concurrency",
      }
    if (status.type === "retry") return { ...base, status_class: "blocked" as Class, status: "blocked_retry" }
    if (status.type === "waiting_user")
      return { ...base, status_class: "blocked" as Class, status: "blocked_user_input" }
    if (status.type === "waiting_permission")
      return { ...base, status_class: "blocked" as Class, status: "blocked_permission" }
    if (status.type === "waiting_child") return { ...base, status_class: "blocked" as Class, status: "blocked_child" }
    if (status.type === "paused") return { ...base, status_class: "blocked" as Class, status: "blocked_paused" }
    if (status.type === "blocked") return { ...base, status_class: "blocked" as Class, status: "blocked" }
    if (status.type === "aborting") return { ...base, status_class: "active" as Class, status: "aborting" }
    if (status.type === "interrupted")
      return { ...base, status_class: "interrupted" as Class, status: status.prior ? "interrupted_active" : "interrupted_unknown" }
    if (status.type === "terminal_reply")
      return { ...base, status_class: "terminal" as Class, status: "terminal_reply" }
    if (status.type === "completed") return { ...base, status_class: "terminal" as Class, status: "terminal_success" }
    if (status.type === "failed") return { ...base, status_class: "terminal" as Class, status: "terminal_failure" }
    if (status.type === "error") return { ...base, status_class: "terminal" as Class, status: "terminal_error" }
    if (status.type === "timeout") return { ...base, status_class: "terminal" as Class, status: "terminal_timeout" }
    if (status.type === "aborted") return { ...base, status_class: "terminal" as Class, status: "terminal_cancelled" }
    if (status.type === "user_completed")
      return { ...base, status_class: "terminal" as Class, status: "terminal_user_completed" }
    if (status.type === "archived") return { ...base, status_class: "archived" as Class, status: "archived" }
    return { ...base, status_class: "active" as Class, status: "active" }
  }

  function decode(row: Row): Info | undefined {
    const detail = row.status_detail ?? {}
    const msg = row.status_message ?? undefined
    if (row.status === "idle") return { type: "idle" }
    if (row.status === "queued" || row.status === "starting" || row.status === "running" || row.status === "aborting") {
      const parsed = Info.safeParse(detail)
      if (parsed.success && parsed.data.type === row.status) return parsed.data
      return { type: "idle" }
    }
    if (row.status_class === "active") return { type: "idle" }
    if (row.status === "blocked_user_input" || row.status === "blocked_confirm") return { type: "waiting_user" }
    if (row.status === "blocked_permission") return { type: "waiting_permission" }
    if (row.status === "blocked_child") return { type: "waiting_child", message: msg }
    if (row.status === "blocked_paused") return { type: "paused", message: msg }
    if (row.status === "blocked_rate_limit" || row.status === "blocked_concurrency") {
      const parsed = Info.safeParse(detail)
      if (parsed.success && parsed.data.type === "rate_limited") return parsed.data
      return { type: "blocked", message: msg }
    }
    if (row.status === "blocked_retry") {
      const parsed = Info.safeParse(detail)
      if (parsed.success && parsed.data.type === "retry") return parsed.data
      return { type: "blocked", message: msg }
    }
    if (row.status_class === "blocked") return { type: "blocked", message: msg }
    if (row.status_class === "interrupted") {
      const parsed = Info.safeParse(detail)
      if (parsed.success && parsed.data.type === "interrupted") return parsed.data
      return { type: "interrupted", message: msg }
    }
    if (row.status === "terminal_reply") return { type: "terminal_reply", message: msg }
    if (row.status === "terminal_success") return { type: "completed" }
    if (row.status === "terminal_failure") return { type: "failed", message: msg }
    if (row.status === "terminal_error") return { type: "error", message: msg ?? "Session ended with an error." }
    if (row.status === "terminal_timeout") return { type: "timeout", message: msg ?? "Session timed out." }
    if (row.status === "terminal_cancelled") return { type: "aborted", message: msg }
    if (row.status === "terminal_user_completed") return { type: "user_completed", message: msg }
    if (row.status_class === "archived") return { type: "archived" }
    return
  }

  function detail(status: Info) {
    if (
      status.type === "queued" ||
      status.type === "starting" ||
      status.type === "running" ||
      status.type === "aborting" ||
      status.type === "paused" ||
      status.type === "rate_limited" ||
      status.type === "retry" ||
      status.type === "interrupted" ||
      status.type === "terminal_reply"
    )
      return status
    return null
  }

  function recoverable(status: Info) {
    return status.type !== "archived"
  }
}
