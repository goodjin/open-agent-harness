import { afterEach, describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { WorkspaceServer } from "../../src/control-plane/workspace-server/server"
import { parseSSE } from "../../src/control-plane/sse"
import { GlobalBus } from "../../src/bus/global"
import { EventGateway } from "../../src/server/event"
import { createOpencodeClient, type EventEnvelope } from "@opencode-ai/sdk/v2"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

describe("control-plane/workspace-server SSE", () => {
  test("streams GlobalBus events and parseSSE reads them", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = WorkspaceServer.App()
    const stop = new AbortController()
    const seen: EventGateway.Envelope[] = []
    try {
      const response = await app.request("/event", {
        signal: stop.signal,
        headers: {
          "x-opencode-workspace": "wrk_test_workspace",
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeDefined()

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for workspace.test event"))
        }, 3000)

        void parseSSE(response.body!, stop.signal, (event) => {
          const parsed = EventGateway.schema().safeParse(event)
          if (!parsed.success) return
          seen.push(parsed.data as EventGateway.Envelope)
          if (parsed.data.payload.type === "server.connected") {
            GlobalBus.emit("event", {
              payload: {
                type: "server.heartbeat",
                properties: {},
              },
            })
            return
          }
          if (parsed.data.payload.type !== "server.heartbeat") return
          clearTimeout(timeout)
          resolve()
        }).catch((error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })

      await done

      expect(seen.some((event) => event.payload.type === "server.connected")).toBe(true)
      expect(seen.some((event) => event.payload.type === "server.heartbeat")).toBe(true)
    } finally {
      stop.abort()
    }
  })

  test("streams canonical envelopes through the SDK client", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = WorkspaceServer.App()
    const stop = new AbortController()
    const client = createOpencodeClient({
      baseUrl: "http://workspace.test",
      directory: tmp.path,
      fetch: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })

    try {
      const res = await client.event.subscribe({ directory: tmp.path }, { signal: stop.signal })
      const seen: EventEnvelope[] = []

      for await (const event of res.stream) {
        seen.push(event)
        if (event.payload.type === "server.connected") break
      }

      expect(seen[0].sequence).toBeNumber()
      expect(seen[0].payload.type).toBe("server.connected")
    } finally {
      stop.abort()
    }
  })
})
