import { afterEach, describe, expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Audit } from "../../src/observability/audit"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

describe("audit route", () => {
  test("filters records by session, project, and event type", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.make("wrk_audit_route")
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const other = await Session.create({})
            await Audit.emit({
              sessionID: session.id,
              event: { type: "restore.completed", hash: "target" },
            })
            await Audit.emit({
              sessionID: other.id,
              event: { type: "restore.completed", hash: "other" },
            })
            await Audit.emit({
              sessionID: session.id,
              event: { type: "memory.captured", count: 1 },
            })

            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}&sessionID=${session.id}&eventType=restore.completed`
            const res = await app.request(`/audit?${query}`)
            expect(res.status).toBe(200)
            const body = await res.json()

            expect(body).toHaveLength(1)
            expect(body[0].sessionID).toBe(session.id)
            expect(body[0].directory).toBeUndefined()
            expect(body[0].event).toEqual({ type: "restore.completed", hash: "target" })
          },
        }),
    })
  })

  test("rejects project mismatch and ignores legacy workspace query", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.make("wrk_audit_route_forbidden")
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            await Audit.emit({
              sessionID: session.id,
              event: { type: "restore.completed", hash: "target" },
            })

            const app = Server.Default()
            const dir = encodeURIComponent(tmp.path)
            const project = ProjectID.make("prj_other")
            const badProject = await app.request(`/audit?directory=${dir}&projectID=${project}`)
            const badWorkspace = await app.request(`/audit?directory=${dir}&workspace=wrk_other&sessionID=${session.id}`)

            expect(badProject.status).toBe(403)
            expect(badWorkspace.status).toBe(200)
          },
        }),
    })
  })

  test("applies default limit with filters and supports cursor pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.make("wrk_audit_route_limit")
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            for (const count of Array.from({ length: 60 }, (_, index) => index)) {
              await Audit.emit({
                sessionID: session.id,
                event: { type: "memory.captured", count },
              })
            }
            await Audit.emit({
              sessionID: session.id,
              event: { type: "restore.completed", hash: "skip" },
            })

            const app = Server.Default()
            const dir = encodeURIComponent(tmp.path)
            const base = `/audit?directory=${dir}&sessionID=${session.id}&eventType=memory.captured`
            const first = await app.request(base)
            expect(first.status).toBe(200)
            const records = (await first.json()) as Audit.Record[]
            expect(records).toHaveLength(50)
            expect(records.every((record) => record.event.type === "memory.captured")).toBe(true)
            expect(records.some((record) => "directory" in record)).toBe(false)

            const next = await app.request(`${base}&limit=2&cursor=${records[0]!.id}`)
            expect(next.status).toBe(200)
            const page = (await next.json()) as Audit.Record[]
            expect(page).toHaveLength(2)
            expect(page[0]!.id).toBe(records[1]!.id)
            expect(page[1]!.id).toBe(records[2]!.id)
          },
        }),
    })
  })

  test("GET audit never returns raw permission patterns or directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.make("wrk_audit_route_secret")
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const patterns = [
              "curl https://example.test/?token=route-token -H 'Authorization: Bearer route-auth'",
              "echo sk-route-secret-1234567890",
            ]
            const ask = PermissionNext.ask({
              sessionID: session.id,
              permission: "bash",
              patterns,
              always: patterns,
              metadata: {},
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            }).catch(() => undefined)

            while ((await PermissionNext.list({ sessionID: session.id })).length === 0) {
              await sleep(5)
            }

            const app = Server.Default()
            const dir = encodeURIComponent(tmp.path)
            const res = await app.request(`/audit?directory=${dir}&sessionID=${session.id}`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as Audit.Record[]
            const text = JSON.stringify(body)
            expect(text).not.toContain(tmp.path)
            expect(text).not.toContain("curl https://example.test")
            expect(text).not.toContain("route-token")
            expect(text).not.toContain("Authorization")
            expect(text).not.toContain("route-auth")
            expect(text).not.toContain("sk-route-secret")

            const event = body.find((record) => record.event.type === "permission.asked")?.event
            expect(event).toEqual(
              expect.objectContaining({
                type: "permission.asked",
                permission: "bash",
                patternCount: 2,
              }),
            )

            const pending = await PermissionNext.list({ sessionID: session.id })
            expect(pending[0]).toBeDefined()
            await PermissionNext.reply({ requestID: pending[0]!.id, reply: "reject" })
            await ask
          },
        }),
    })
  })

  test("saved OpenAPI includes audit route and schemas", async () => {
    const spec = (await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()) as {
      paths: Record<string, unknown>
      components?: { schemas?: Record<string, unknown> }
    }
    expect(spec.paths["/audit"]).toBeDefined()
    expect(spec.components?.schemas?.AuditRecord).toBeDefined()
    expect(spec.components?.schemas?.AuditEvent).toBeDefined()
    expect(spec.components?.schemas?.AuditEventType).toBeDefined()
  })
})
