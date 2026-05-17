import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Metrics } from "@/observability/metrics"
import { SessionID } from "./schema"
import z from "zod"

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
        type: z.literal("waiting_permission"),
      }),
      z.object({
        type: z.literal("waiting_user"),
      }),
      z.object({
        type: z.literal("error"),
        message: z.string(),
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

  const transitions: Record<Info["type"], Info["type"][]> = {
    idle: ["idle", "running", "waiting_permission", "waiting_user", "error"],
    running: ["idle", "running", "waiting_permission", "waiting_user", "error", "retry"],
    waiting_permission: ["idle", "running", "waiting_permission", "waiting_user", "error"],
    waiting_user: ["idle", "running", "waiting_permission", "waiting_user", "error"],
    error: ["idle", "running", "error"],
    retry: ["idle", "running", "error", "retry"],
  }

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

  export function set(sessionID: SessionID, status: Info) {
    const current = get(sessionID)
    if (!transitions[current.type].includes(status.type)) {
      throw new InvalidTransitionError(current.type, status.type)
    }
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
      return
    }
    state()[sessionID] = status
  }

  export function dismiss(sessionID: SessionID) {
    const current = get(sessionID)
    if (current.type !== "error") return current
    set(sessionID, { type: "idle" })
    return get(sessionID)
  }
}
