import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

describe("permission.inspect endpoint", () => {
  test("returns effective policy and sanitized trace", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: "allow",
          question: "ask",
        },
      },
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await Bun.write(
          path.join(dir, ".opencode", "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            permission: {
              bash: "allow",
              question: "ask",
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({
              permission: [
                { permission: "bash", pattern: "rm *", action: "deny" },
                { permission: "question", pattern: "*", action: "allow" },
              ],
            })
            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}&workspace=${WorkspaceID.make("test-workspace")}`
            const res = await app.request(
              `/permission/inspect?${query}&sessionID=${session.id}&agent=default&permission=question&pattern=*`,
            )
            expect(res.status).toBe(200)
            const body = await res.json()
            expect(body).toMatchObject({
              sessionID: session.id,
              agent: "default",
              trace: {
                action: "allow",
                rule: {
                  permission: "question",
                  pattern: "*",
                  action: "allow",
                  source: "session",
                },
              },
            })
            expect(
              body.policy.rules.some(
                (rule: { permission: string; pattern: string }) => rule.permission === "bash" && rule.pattern === "rm *",
              ),
            ).toBe(true)
            const sources = new Set(body.policy.rules.map((rule: { source: string }) => rule.source))
            expect(sources.has("default")).toBe(true)
            expect(sources.has("user")).toBe(true)
            expect(sources.has("session")).toBe(true)
            const matched = new Set(body.trace.matched.map((rule: { source: string }) => rule.source))
            expect(matched.has("default")).toBe(true)
            expect(matched.has("session")).toBe(true)
            expect(body.trace.rule.metadata).toBeUndefined()
            expect(
              body.trace.matched.every(
                (rule: { permission: string; pattern: string; action: string }) =>
                  rule.permission && rule.pattern && rule.action,
              ),
            ).toBe(true)
          },
        }),
    })
  })
})
