import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { SessionLog } from "../../src/session/log"
import { Storage } from "../../src/storage/storage"
import { SessionRunner } from "../../src/session/runner"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

async function fill(sessionID: SessionID, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await Session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await Session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

describe("session messages endpoint", () => {
  test("returns cursor headers for older pages", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const ids = await fill(session.id, 5)
            const app = Server.Default()

            const a = await app.request(`/session/${session.id}/message?limit=2`)
            expect(a.status).toBe(200)
            const aBody = (await a.json()) as MessageV2.WithParts[]
            expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
            const cursor = a.headers.get("x-next-cursor")
            expect(cursor).toBeTruthy()
            expect(a.headers.get("link")).toContain('rel="next"')

            const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
            expect(b.status).toBe(200)
            const bBody = (await b.json()) as MessageV2.WithParts[]
            expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("keeps full-history responses when limit is omitted", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const ids = await fill(session.id, 3)
            const app = Server.Default()

            const res = await app.request(`/session/${session.id}/message`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as MessageV2.WithParts[]
            expect(body.map((item) => item.info.id)).toEqual(ids)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("does not recover protocol sessions when reading messages", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            await fill(session.id, 1)
            const recover = spyOn(SessionRunner, "recover").mockImplementation(async () => true)

            try {
              const app = Server.Default()
              const res = await app.request(`/session/${session.id}/message?limit=1`)

              expect(res.status).toBe(200)
              expect(recover).not.toHaveBeenCalled()
            } finally {
              recover.mockRestore()
              await Session.remove(session.id)
            }
          },
        }),
    })
  })

  test("rejects invalid cursors and missing sessions", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const app = Server.Default()

            const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
            expect(bad.status).toBe(400)

            const miss = await app.request(`/session/ses_missing/message?limit=2`)
            expect(miss.status).toBe(404)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("does not truncate large legacy limit requests", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            await fill(session.id, 520)
            const app = Server.Default()

            const res = await app.request(`/session/${session.id}/message?limit=510`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as MessageV2.WithParts[]
            expect(body).toHaveLength(510)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("returns slim message parts for chat views", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const id = MessageID.ascending()
            await Session.updateMessage({
              id,
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now() },
              parentID: MessageID.ascending(),
              mode: "",
              agent: "test",
              path: { cwd: root, root },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: "test",
              providerID: "test",
              summary: true,
            } as unknown as MessageV2.Info)
            await Session.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: id,
              type: "step-start",
              snapshot: "abc",
              dsl_context: { protocol: { prompt: "x".repeat(10_000) } },
            })
            await Session.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: id,
              type: "text",
              text: "p".repeat(4_000),
              ignored: true,
              metadata: { kind: "protocol_context" },
            })
            await Session.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: id,
              type: "tool",
              callID: "call_test",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "echo hi" },
                output: "o".repeat(30_000),
                title: "bash",
                metadata: { raw: "m".repeat(30_000) },
                time: { start: Date.now(), end: Date.now() },
              },
            })

            const app = Server.Default()
            const res = await app.request(`/session/${session.id}/message?limit=1`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as MessageV2.WithParts[]
            const parts = body[0]!.parts
            const step = parts.find((item) => item.type === "step-start") as MessageV2.StepStartPart
            const text = parts.find((item) => item.type === "text") as MessageV2.TextPart
            const tool = parts.find((item) => item.type === "tool") as MessageV2.ToolPart
            expect(step.snapshot).toBe("abc")
            expect(step.dsl_context).toBeUndefined()
            expect(text.text.length).toBeLessThan(2_100)
            expect(tool.state.status).toBe("completed")
            if (tool.state.status === "completed") {
              expect(tool.state.output.length).toBeLessThan(20_100)
              expect(tool.state.metadata.raw).toEqual({ omitted: true, bytes: 30_002 })
            }

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("returns diff summaries in message and session diff responses while detail keeps full contents", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            const id = MessageID.ascending()
            const diff = {
              file: "large.txt",
              before: "before".repeat(100),
              after: "after".repeat(100),
              additions: 7,
              deletions: 3,
              status: "modified" as const,
            }
            await Session.updateMessage({
              id,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              summary: { diffs: [diff] },
              agent: "test",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)
            await Storage.write(["session_diff", session.id], [diff])

            const app = Server.Default()
            const messages = await app.request(`/session/${session.id}/message?limit=1`)
            expect(messages.status).toBe(200)
            const body = (await messages.json()) as MessageV2.WithParts[]
            const item = body[0]!.info
            expect(item.role).toBe("user")
            if (item.role === "user") {
              expect(item.summary?.diffs?.[0]).toMatchObject({
                file: "large.txt",
                before: "",
                after: "",
                additions: 7,
                deletions: 3,
                status: "modified",
              })
            }

            const summary = await app.request(`/session/${session.id}/diff`)
            expect(summary.status).toBe(200)
            expect(await summary.json()).toEqual([
              { file: "large.txt", before: "", after: "", additions: 7, deletions: 3, status: "modified" },
            ])

            const detail = await app.request(
              `/session/${session.id}/diff/detail?messageID=${id}&file=${encodeURIComponent("large.txt")}`,
            )
            expect(detail.status).toBe(200)
            expect(await detail.json()).toEqual(diff)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("returns exported protocol trace", async () => {
    await Instance.provide({
      directory: root,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            await SessionLog.emit({
              sessionID: session.id,
              level: "info",
              type: "protocol.started",
              data: { runID: "apr_route", title: "Route" },
            })

            const app = Server.Default()
            const res = await app.request(`/session/${session.id}/protocol/apr_route/trace`)
            const body = await res.json()

            expect(res.status).toBe(200)
            expect(body.type).toBe("agent.protocol.trace")
            expect(body.run_id).toBe("apr_route")

            await Session.remove(session.id)
          },
        }),
    })
  })
})
