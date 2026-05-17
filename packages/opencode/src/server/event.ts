import { BusEvent } from "@/bus/bus-event"
import { WorkspaceID } from "@/control-plane/schema"
import { SessionID } from "@/session/schema"
import z from "zod"

export const Event = {
  Connected: BusEvent.define("server.connected", z.object({})),
  Heartbeat: BusEvent.define("server.heartbeat", z.object({})),
  Disposed: BusEvent.define("global.disposed", z.object({})),
}

export namespace EventGateway {
  export function schema(ref = "EventEnvelope") {
    return z
      .object({
        sequence: z.number().int().nonnegative(),
        time: z.number().int().nonnegative(),
        directory: z.string().optional(),
        workspaceID: z.string().optional(),
        sessionID: z.string().optional(),
        payload: BusEvent.payloads(),
      })
      .meta({
        ref,
      })
  }

  export type Payload = {
    type: string
    properties: unknown
  }

  export type Envelope = {
    sequence: number
    time: number
    directory?: string
    workspaceID?: WorkspaceID
    sessionID?: SessionID
    payload: Payload
  }

  export type Input = {
    directory?: string
    workspaceID?: WorkspaceID
    payload: Payload
  }

  export type Filter = {
    directory?: string
    workspaceID?: WorkspaceID
    sessionID?: SessionID
    sequence?: number
  }

  export const Query = z.object({
    directory: z.string().optional().meta({ description: "Filter events by workspace directory" }),
    sessionID: SessionID.zod.optional().meta({ description: "Filter events by session id" }),
    sequence: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .meta({ description: "Replay events after this sequence id" }),
  })

  export type Query = z.infer<typeof Query>

  const max = 2_000
  let next = 0
  const history: Envelope[] = []

  function object(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }

  export function payload(value: unknown): value is Payload {
    if (!object(value)) return false
    if (typeof value.type !== "string") return false
    return "properties" in value
  }

  function text(value: unknown) {
    if (typeof value !== "string") return
    return value
  }

  function session(payload: Payload) {
    if (!object(payload.properties)) return
    const props = payload.properties
    const direct = text(props.sessionID)
    if (direct) return direct as SessionID

    const info = object(props.info) ? props.info : undefined
    const nested = text(info?.sessionID)
    if (nested) return nested as SessionID
    if (payload.type.startsWith("session.")) {
      const id = text(info?.id)
      if (id) return id as SessionID
    }

    const part = object(props.part) ? props.part : undefined
    const child = text(part?.sessionID)
    if (child) return child as SessionID
  }

  function workspace(input: Input) {
    if (input.workspaceID) return input.workspaceID
    if (!object(input.payload.properties)) return
    const props = input.payload.properties
    const direct = text(props.workspaceID)
    if (direct) return direct as WorkspaceID
    const info = object(props.info) ? props.info : undefined
    const nested = text(info?.workspaceID)
    if (nested) return nested as WorkspaceID
  }

  export function record(input: Input, opts?: { store?: boolean }): Envelope {
    const event = {
      sequence: ++next,
      time: Date.now(),
      directory: input.directory,
      workspaceID: workspace(input),
      sessionID: session(input.payload),
      payload: input.payload,
    }
    if (opts?.store !== false) {
      history.push(event)
      if (history.length > max) history.splice(0, history.length - max)
    }
    return event
  }

  export function replay(filter: Filter) {
    return history.filter((event) => match(event, filter))
  }

  export function cursor() {
    return next
  }

  export function match(event: Envelope, filter: Filter) {
    if (filter.sequence !== undefined && event.sequence <= filter.sequence) return false
    if (filter.directory !== undefined && event.directory !== filter.directory) return false
    if (filter.workspaceID !== undefined && event.workspaceID !== filter.workspaceID) return false
    if (filter.sessionID !== undefined && event.sessionID !== filter.sessionID) return false
    return true
  }

  export function filter(query: Query, fallback?: { directory?: string; workspaceID?: WorkspaceID }): Filter {
    return {
      directory: fallback?.directory ?? query.directory,
      workspaceID: fallback?.workspaceID,
      sessionID: query.sessionID,
      sequence: query.sequence,
    }
  }

  export function stream(filter: Filter, send: (event: Envelope) => Promise<void>) {
    let buf: Envelope[] = []
    let live = false
    let last = filter.sequence ?? -1
    const seen = new Set<number>()

    const emit = async (event: Envelope) => {
      if (seen.has(event.sequence)) return false
      if (event.sequence <= last) return false
      seen.add(event.sequence)
      last = event.sequence
      await send(event)
      return true
    }

    const flush = async (keep?: (event: Envelope) => boolean) => {
      const ready = buf.filter((event) => keep?.(event) ?? true).sort((a, b) => a.sequence - b.sequence)
      const seq = new Set(ready.map((event) => event.sequence))
      buf = buf.filter((event) => !seq.has(event.sequence))
      for (const event of ready) {
        await emit(event)
      }
    }

    return {
      async push(event: Envelope) {
        if (!match(event, filter)) return false
        if (!live) {
          buf.push(event)
          return false
        }
        return emit(event)
      },
      async replay(connect: () => Envelope) {
        for (const event of replay(filter)) {
          await emit(event)
        }
        const event = connect()
        await flush((item) => item.sequence < event.sequence)
        await emit(event)
        while (buf.length > 0) {
          await flush()
        }
        live = true
      },
    }
  }
}
