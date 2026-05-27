import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Event, EventGateway } from "../../src/server/event"
import { Instance } from "../../src/project/instance"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { PermissionNext } from "../../src/permission/next"
import { PermissionID } from "../../src/permission/schema"
import { SessionTimeline } from "../../src/session/timeline"
import { Server } from "../../src/server/server"
import { parseSSE } from "../../src/control-plane/sse"
import { createOpencodeClient, type EventEnvelope } from "@open-agent-harness/sdk/v2"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

function envelopes(body: ReadableStream<Uint8Array>, signal: AbortSignal, push: (event: EventGateway.Envelope) => void) {
  return parseSSE(body, signal, (event) => {
    const parsed = EventGateway.schema().safeParse(event)
    if (!parsed.success) return
    push(parsed.data as EventGateway.Envelope)
  })
}

async function audit(dir: string, hash: string, sessionID: SessionID, workspaceID?: WorkspaceID) {
  await Instance.provide({
    directory: dir,
    fn: () =>
      WorkspaceContext.provide({
        workspaceID,
        fn: () =>
          Bus.publish(SessionTimeline.Event.Audit, {
            type: "restore",
            sessionID,
            hash,
          }),
      }),
  })
}

function hash(event: EventGateway.Envelope) {
  const props = event.payload.properties
  if (typeof props !== "object" || props === null) return
  if (!("hash" in props) || typeof props.hash !== "string") return
  return props.hash
}

function rec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function params(spec: unknown, path: string) {
  if (!rec(spec)) return []
  const paths = rec(spec.paths) ? spec.paths : undefined
  const route = paths && rec(paths[path]) ? paths[path] : undefined
  const get = route && rec(route.get) ? route.get : undefined
  const raw = get && Array.isArray(get.parameters) ? get.parameters : []
  return raw
    .map((item) => (typeof item === "object" && item !== null && "name" in item ? item.name : undefined))
    .filter((item): item is string => typeof item === "string")
}

function schema(spec: unknown, path: string) {
  if (!rec(spec)) return
  const paths = rec(spec.paths) ? spec.paths : undefined
  const route = paths && rec(paths[path]) ? paths[path] : undefined
  const get = route && rec(route.get) ? route.get : undefined
  const responses = get && rec(get.responses) ? get.responses : undefined
  const ok = responses && rec(responses["200"]) ? responses["200"] : undefined
  const content = ok && rec(ok.content) ? ok.content : undefined
  const stream = content && rec(content["text/event-stream"]) ? content["text/event-stream"] : undefined
  if (!stream || !("schema" in stream)) return
  return stream.schema
}

function route(app: ReturnType<typeof Server.Default>, dir: string, input: RequestInfo | URL, init?: RequestInit) {
  return Instance.provide({
    directory: dir,
    fn: () => app.request(input, init),
  })
}

describe("server event gateway", () => {
  test("canonical envelope schema requires sequence, time, and payload", () => {
    const event = EventGateway.record(
      {
        directory: "/tmp/opencode-events",
        payload: {
          type: Event.Connected.type,
          properties: {},
        },
      },
      { store: false },
    )

    const schema = EventGateway.schema()
    expect(schema.safeParse(event).success).toBe(true)
    expect(schema.safeParse({ time: event.time, payload: event.payload }).success).toBe(false)
    expect(schema.safeParse({ sequence: event.sequence, payload: event.payload }).success).toBe(false)
    expect(schema.safeParse({ sequence: event.sequence, time: event.time }).success).toBe(false)
  })

  test("replays missed events after a sequence id in order", async () => {
    await using tmp = await tmpdir({ git: true })
    const sid = SessionID.make("ses_event_replay")
    const start = EventGateway.cursor()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionStatus.set(sid, { type: "running" })
        SessionStatus.set(sid, { type: "idle" })
      },
    })

    const replay = EventGateway.replay({ directory: tmp.path, sequence: start, sessionID: sid })
    expect(replay.map((event) => event.payload.type)).toEqual(["session.status", "session.status", "session.idle"])
    expect(replay.map((event) => event.sequence)).toEqual([...replay].map((event) => event.sequence).sort((a, b) => a - b))
  })

  test("filters replay by session id", async () => {
    await using tmp = await tmpdir({ git: true })
    const a = SessionID.make("ses_event_session_a")
    const b = SessionID.make("ses_event_session_b")
    const start = EventGateway.cursor()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionStatus.set(a, { type: "running" })
        SessionStatus.set(b, { type: "running" })
      },
    })

    expect(EventGateway.replay({ directory: tmp.path, sequence: start, sessionID: a }).map((event) => event.sessionID)).toEqual([
      a,
    ])
  })

  test("legacy EventGateway workspace filter remains available for replay compatibility", async () => {
    await using tmp = await tmpdir({ git: true })
    const a = WorkspaceID.make("wrk_event_workspace_a")
    const b = WorkspaceID.make("wrk_event_workspace_b")
    const sid = SessionID.make("ses_event_workspace")
    const start = EventGateway.cursor()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: a,
          fn: () => SessionStatus.set(sid, { type: "running" }),
        })
        await WorkspaceContext.provide({
          workspaceID: b,
          fn: () => SessionStatus.set(sid, { type: "idle" }),
        })
      },
    })

    const replay = EventGateway.replay({ directory: tmp.path, workspaceID: a, sequence: start })
    expect(replay.map((event) => event.workspaceID)).toEqual([a])
    expect(replay.some((event) => event.workspaceID === b)).toBe(false)
  })

  test("state, permission, and checkpoint events enter the canonical gateway", async () => {
    await using tmp = await tmpdir({ git: true })
    const sid = SessionID.make("ses_event_gateway")
    const start = EventGateway.cursor()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionStatus.set(sid, { type: "running" })
        await Bus.publish(PermissionNext.Event.Asked, {
          id: PermissionID.ascending(),
          sessionID: sid,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
        })
        await Bus.publish(SessionTimeline.Event.Audit, {
          type: "restore",
          sessionID: sid,
          hash: "checkpoint-event-gateway",
        })
      },
    })

    expect(EventGateway.replay({ directory: tmp.path, sequence: start }).map((event) => event.payload.type)).toEqual([
      "session.status",
      "permission.asked",
      "session.timeline.audit",
    ])
  })

  test("server route streams canonical envelopes through the SDK client", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const sid = SessionID.make("ses_event_sdk")
    const start = EventGateway.cursor()

    await Instance.provide({
      directory: tmp.path,
      fn: () => SessionStatus.set(sid, { type: "running" }),
    })

    const stop = new AbortController()
    const client = createOpencodeClient({
      baseUrl: "http://opencode.test",
      directory: tmp.path,
      fetch: ((input, init) =>
        Instance.provide({
          directory: tmp.path,
          fn: () => app.fetch(new Request(input, init)),
        })) as typeof fetch,
    })

    const res = await client.event.subscribe(
      {
        sequence: start,
        sessionID: sid,
      },
      { signal: stop.signal },
    )

    const seen: EventEnvelope[] = []
    for await (const event of res.stream) {
      seen.push(event)
      if (seen.some((item) => item.payload.type === "session.status") && event.payload.type === "server.connected") break
    }
    stop.abort()

    expect(seen.some((event) => event.payload.type === "server.connected")).toBe(true)
    expect(seen.find((event) => event.payload.type === "session.status")?.sessionID).toBe(sid)
  })

  test("server route replays before connected with monotonic sequences", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const sid = SessionID.make("ses_event_route_replay")
    const start = EventGateway.cursor()

    await audit(tmp.path, "route-replay-one", sid)
    await audit(tmp.path, "route-replay-two", sid)

    const stop = new AbortController()
    const seen: EventGateway.Envelope[] = []
    try {
      const res = await route(app, tmp.path, `/event?sequence=${start}&sessionID=${sid}`, {
        signal: stop.signal,
      })

      expect(res.status).toBe(200)
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for replay")), 3000)
        void envelopes(res.body!, stop.signal, (event) => {
          seen.push(event)
          if (!seen.some((item) => item.payload.type === "server.connected")) return
          if (seen.filter((item) => hash(item)?.startsWith("route-replay-")).length !== 2) return
          clearTimeout(timeout)
          resolve()
        }).catch((err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      await done
    } finally {
      stop.abort()
    }

    expect(seen.map((event) => event.sequence)).toEqual([...seen].map((event) => event.sequence).sort((a, b) => a - b))
    expect(seen.findIndex((event) => hash(event) === "route-replay-one")).toBeLessThan(
      seen.findIndex((event) => event.payload.type === "server.connected"),
    )
  })

  test("server route does not drop or duplicate events at the replay/live boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const sid = SessionID.make("ses_event_boundary")
    const start = EventGateway.cursor()

    await Promise.all(Array.from({ length: 20 }, (_, index) => audit(tmp.path, `boundary-replay-${index}`, sid)))

    const stop = new AbortController()
    const seen: EventGateway.Envelope[] = []
    const state = { fired: false }
    try {
      const res = await route(app, tmp.path, `/event?sequence=${start}&sessionID=${sid}`, {
        signal: stop.signal,
      })

      expect(res.status).toBe(200)
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for boundary live event")), 3000)
        void envelopes(res.body!, stop.signal, (event) => {
          seen.push(event)
          if (hash(event)?.startsWith("boundary-replay-") && !state.fired) {
            state.fired = true
            void audit(tmp.path, "boundary-live", sid)
          }
          if (hash(event) !== "boundary-live") return
          clearTimeout(timeout)
          resolve()
        }).catch((err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      await done
    } finally {
      stop.abort()
    }

    expect(seen.filter((event) => hash(event)?.startsWith("boundary-replay-")).length).toBe(20)
    expect(seen.filter((event) => hash(event) === "boundary-live").length).toBe(1)
    expect(new Set(seen.map((event) => event.sequence)).size).toBe(seen.length)
    expect(seen.map((event) => event.sequence)).toEqual([...seen].map((event) => event.sequence).sort((a, b) => a - b))
  })

  test("stream drains events pushed while the replay buffer is flushing", async () => {
    const dir = `/tmp/opencode-event-drain-${Date.now()}`
    const start = EventGateway.cursor()
    const seen: EventGateway.Envelope[] = []
    const state = {
      one: false,
      two: false,
    }
    let gate: ReturnType<typeof EventGateway.stream>
    const make = (name: string) =>
      EventGateway.record(
        {
          directory: dir,
          payload: {
            type: name,
            properties: { hash: name },
          },
        },
        { store: false },
      )

    gate = EventGateway.stream({ directory: dir, sequence: start }, async (event) => {
      seen.push(event)
      if (event.payload.type === Event.Connected.type && !state.one) {
        state.one = true
        await gate.push(make("boundary-one"))
        return
      }
      if (hash(event) === "boundary-one" && !state.two) {
        state.two = true
        await gate.push(make("boundary-two"))
      }
    })

    await gate.replay(() =>
      EventGateway.record(
        {
          directory: dir,
          payload: {
            type: Event.Connected.type,
            properties: {},
          },
        },
        { store: false },
      ),
    )

    expect(seen.map((event) => event.payload.type)).toEqual([
      Event.Connected.type,
      "boundary-one",
      "boundary-two",
    ])
    expect(new Set(seen.map((event) => event.sequence)).size).toBe(seen.length)
    expect(seen.map((event) => event.sequence)).toEqual([...seen].map((event) => event.sequence).sort((a, b) => a - b))
  })

  test("server route filters replay and live events by directory and session without workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const sid = SessionID.make("ses_event_unscoped")
    const start = EventGateway.cursor()

    await audit(tmp.path, "workspace-unscoped-replay", sid)

    const stop = new AbortController()
    const seen: EventGateway.Envelope[] = []
    try {
      const res = await route(app, tmp.path, `/event?sequence=${start}&sessionID=${sid}`, {
        signal: stop.signal,
      })

      expect(res.status).toBe(200)
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for scoped live event")), 3000)
        void envelopes(res.body!, stop.signal, (event) => {
          seen.push(event)
          if (event.payload.type === "server.connected") {
            void audit(tmp.path, "workspace-unscoped-live", sid)
          }
          if (hash(event) !== "workspace-unscoped-live") return
          clearTimeout(timeout)
          resolve()
        }).catch((err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      await done
      await Bun.sleep(20)
    } finally {
      stop.abort()
    }

    expect(seen.some((event) => hash(event) === "workspace-unscoped-replay")).toBe(true)
    expect(seen.some((event) => hash(event) === "workspace-unscoped-live")).toBe(true)
  })

  test("server route filters live events by session", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const sid = SessionID.make("ses_event_live")
    const other = SessionID.make("ses_event_other")
    const stop = new AbortController()
    const seen: EventGateway.Envelope[] = []

    const res = await route(app, tmp.path, `/event?sessionID=${sid}`, {
      signal: stop.signal,
    })

    expect(res.status).toBe(200)
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for live event")), 3000)
      void envelopes(res.body!, stop.signal, (event) => {
        seen.push(event)
        if (event.payload.type !== "server.connected") return
        void Instance.provide({
          directory: tmp.path,
          fn: () => {
            SessionStatus.set(other, { type: "running" })
            SessionStatus.set(sid, { type: "running" })
          },
        })
        return
      })
      const check = setInterval(() => {
        if (!seen.some((event) => event.sessionID === sid)) return
        clearInterval(check)
        clearTimeout(timeout)
        resolve()
        return
      }, 5)
    })

    await done
    await Bun.sleep(20)
    stop.abort()

    expect(seen.some((event) => event.sessionID === other)).toBe(false)
    expect(seen.some((event) => event.sessionID === sid)).toBe(true)
  })

  test("global route replays and filters by directory, session, and sequence", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const sid = SessionID.make("ses_global_filter")
    const other = SessionID.make("ses_global_other")
    const space = WorkspaceID.ascending()
    const start = EventGateway.cursor()

    await audit(tmp.path, "global-replay-target", sid, space)
    await audit(tmp.path, "global-replay-session", other, space)
    await audit(tmp.path, "global-replay-legacy-workspace", sid, WorkspaceID.ascending())
    await audit("/tmp/opencode-global-other", "global-replay-directory", sid, space)

    const stop = new AbortController()
    const seen: EventGateway.Envelope[] = []
    try {
      const res = await app.request(
        `/global/event?directory=${encodeURIComponent(tmp.path)}&sessionID=${sid}&sequence=${start}`,
        {
          signal: stop.signal,
        },
      )

      expect(res.status).toBe(200)
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for global live target")), 3000)
        void envelopes(res.body!, stop.signal, (event) => {
          seen.push(event)
          if (event.payload.type === "server.connected") {
            void audit(tmp.path, "global-live-session", other, space)
            void audit(tmp.path, "global-live-legacy-workspace", sid, WorkspaceID.ascending())
            void audit(tmp.path, "global-live-target", sid, space)
          }
          if (hash(event) !== "global-live-target") return
          clearTimeout(timeout)
          resolve()
        }).catch((err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      await done
      await Bun.sleep(20)
    } finally {
      stop.abort()
    }

    expect(seen.some((event) => hash(event) === "global-replay-target")).toBe(true)
    expect(seen.some((event) => hash(event) === "global-live-target")).toBe(true)
    expect(seen.some((event) => hash(event) === "global-replay-session")).toBe(false)
    expect(seen.some((event) => hash(event) === "global-replay-legacy-workspace")).toBe(true)
    expect(seen.some((event) => hash(event) === "global-replay-directory")).toBe(false)
    expect(seen.some((event) => hash(event) === "global-live-session")).toBe(false)
    expect(seen.some((event) => hash(event) === "global-live-legacy-workspace")).toBe(true)
  })

  test("saved openapi documents event envelopes and replay filters", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()

    expect(params(spec, "/event")).toEqual(expect.arrayContaining(["directory", "sessionID", "sequence"]))
    expect(params(spec, "/event")).not.toContain("workspace")
    expect(params(spec, "/global/event")).toEqual(
      expect.arrayContaining(["directory", "sessionID", "sequence"]),
    )
    expect(params(spec, "/global/event")).not.toContain("workspace")
    expect(schema(spec, "/event")).toEqual({ $ref: "#/components/schemas/EventEnvelope" })
    expect(schema(spec, "/global/event")).toEqual({ $ref: "#/components/schemas/GlobalEvent" })
    expect(spec.components.schemas.GlobalEvent).toEqual(spec.components.schemas.EventEnvelope)
  })
})
