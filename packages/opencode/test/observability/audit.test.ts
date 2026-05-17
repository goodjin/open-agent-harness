import { afterEach, describe, expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { Bus } from "../../src/bus"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Audit } from "../../src/observability/audit"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

describe("audit taxonomy", () => {
  test("schema covers permission, restore, workflow, and memory events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_audit_taxonomy"),
          fn: async () => {
            const sessionID = SessionID.make("ses_audit_taxonomy")
            const events = [
              { type: "permission.asked", requestID: "per_1", permission: "bash", patterns: ["*"] },
              { type: "permission.replied", requestID: "per_1", reply: "once" },
              { type: "restore.completed", hash: "abc123" },
              { type: "workflow.started", workflowID: "flow", runID: "run" },
              { type: "workflow.paused", workflowID: "flow", runID: "run", status: "waiting_user", step: "ask" },
              { type: "workflow.completed", workflowID: "flow", runID: "run" },
              { type: "workflow.failed", workflowID: "flow", runID: "run", step: "fail" },
              { type: "memory.captured", count: 2 },
              { type: "memory.failed", reason: "extract" },
            ] satisfies Audit.EmitDetail[]

            for (const event of events) {
              const record = await Audit.emit({ sessionID, event })
              expect(Audit.Record.safeParse(record).success).toBe(true)
            }

            expect(Audit.query({ sessionID }).map((record) => record.event.type)).toEqual(
              events.map((event) => event.type),
            )
          },
        }),
    })
  })

  test("permission audit stores pattern summaries without sensitive raw text", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_audit_secret"),
          fn: async () => {
            const session = await Session.create({})
            const patterns = [
              "curl https://api.example.test/run?token=url-token-secret -H 'Authorization: Bearer auth-secret'",
              "echo sk-test-secret-1234567890",
              "output: provider returned Authorization: Bearer should-not-leak",
            ]
            const events: string[] = []
            const unsub = Bus.subscribe(PermissionNext.Event.Audit, (event) => {
              events.push(JSON.stringify(event.properties))
            })
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

            const records = Audit.query({ sessionID: session.id, eventType: "permission.asked" })
            const text = JSON.stringify(records) + events.join("\n")
            expect(records).toHaveLength(1)
            expect(records[0].event).toEqual(
              expect.objectContaining({
                type: "permission.asked",
                permission: "bash",
                patternCount: 3,
                patternKinds: expect.arrayContaining(["secret"]),
              }),
            )
            expect(text).not.toContain("curl https://api.example.test/run")
            expect(text).not.toContain("url-token-secret")
            expect(text).not.toContain("Authorization")
            expect(text).not.toContain("auth-secret")
            expect(text).not.toContain("sk-test-secret")
            expect(text).not.toContain("should-not-leak")
            expect(text).not.toContain("output: provider returned")

            const pending = await PermissionNext.list({ sessionID: session.id })
            expect(pending[0]).toBeDefined()
            await PermissionNext.reply({
              requestID: pending[0]!.id,
              reply: "reject",
              message:
                "reject curl https://api.example.test/run?token=reply-token -H 'Authorization: Bearer reply-auth' sk-reply-secret-1234567890",
            })
            await ask
            const final = JSON.stringify(Audit.query({ sessionID: session.id })) + events.join("\n")
            expect(final).toContain('"feedback":true')
            expect(final).not.toContain("curl https://api.example.test/run")
            expect(final).not.toContain("reply-token")
            expect(final).not.toContain("Authorization")
            expect(final).not.toContain("reply-auth")
            expect(final).not.toContain("sk-reply-secret")
            unsub()
          },
        }),
    })
  })

  test("mod15 gate checks saved openapi and generated sdk consistency", async () => {
    const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts["check:sdk"]).toContain("script/check-sdk.ts")
    expect(pkg.scripts["gate:mod15"]).toContain("bun run check:sdk")
  })
})
