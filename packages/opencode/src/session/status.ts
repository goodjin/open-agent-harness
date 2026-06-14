import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Metrics } from "@/observability/metrics"
import { SessionID } from "./schema"
import { Storage } from "@/storage/storage"
import z from "zod"
import { SessionLog } from "./log"

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
      "archived",
    ],
    queued: ["idle", "starting", "running", "waiting_child", "aborted", "failed", "blocked", "interrupted"],
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
    ],
    error: ["idle", "running", "rate_limited", "waiting_child", "error", "timeout", "aborted", "failed", "blocked", "archived"],
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
      "archived",
    ],
    retry: ["idle", "running", "rate_limited", "waiting_child", "error", "timeout", "retry", "paused", "aborted", "failed", "blocked"],
    paused: ["idle", "running", "waiting_child", "aborting", "aborted", "failed", "blocked"],
    aborting: ["idle", "aborted", "failed"],
    aborted: ["idle", "running", "waiting_child", "aborted", "archived"],
    failed: ["idle", "running", "waiting_child", "failed", "archived"],
    blocked: ["idle", "running", "waiting_permission", "waiting_user", "waiting_child", "aborted", "failed", "blocked"],
    interrupted: ["idle", "running", "waiting_child", "aborted", "failed", "blocked", "archived"],
    completed: ["idle", "running", "rate_limited", "waiting_child", "completed", "archived"],
    archived: ["idle", "archived"],
  }

  type Restart = Extract<Info, { type: "starting" | "running" }>
  const restart = new Set<Restart["type"]>(["starting", "running"])
  const lost = (status: Info): status is Restart => restart.has(status.type as Restart["type"])

  export function get(sessionID: SessionID) {
    return (
      state()[sessionID] ?? {
        type: "idle",
      }
    )
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
    const run = prior
      .then(() =>
        status.type === "idle" || status.type === "archived"
          ? Storage.remove(["session_status", sessionID])
          : Storage.write(["session_status", sessionID], {
              sessionID,
              projectID: Instance.project.id,
              directory: Instance.directory,
              status,
              time: Date.now(),
            } satisfies Saved),
      )
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
    const keys = await Storage.list(["session_status"])
    const out: Record<string, Info> = {}
    for (const key of keys) {
      const item = await Storage.read<Saved>(key).catch(() => undefined)
      if (!item) continue
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
}
