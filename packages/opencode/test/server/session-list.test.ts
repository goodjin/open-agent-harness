import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("Session.list", () => {
  test("filters by directory", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const first = await Session.create({})

            const otherDir = path.join(projectRoot, "..", "__session_list_other")
            const second = await Instance.provide({
              directory: otherDir,
              fn: async () =>
                WorkspaceContext.provide({
                  workspaceID: WorkspaceID.make("test-workspace"),
                  fn: async () => Session.create({}),
                }),
            })

            const sessions = [...Session.list({ directory: projectRoot })]
            const ids = sessions.map((s) => s.id)

            expect(ids).toContain(first.id)
            expect(ids).not.toContain(second.id)
          },
        }),
    })
  })

  test("filters root sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const root = await Session.create({ title: "root-session" })
            const child = await Session.create({ title: "child-session", parentID: root.id })

            const sessions = [...Session.list({ roots: true })]
            const ids = sessions.map((s) => s.id)

            expect(ids).toContain(root.id)
            expect(ids).not.toContain(child.id)
          },
        }),
    })
  })

  test("filters by start time", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({ title: "new-session" })
            const futureStart = Date.now() + 86400000

            const sessions = [...Session.list({ start: futureStart })]
            expect(sessions.length).toBe(0)
          },
        }),
    })
  })

  test("filters by search term", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            await Session.create({ title: "unique-search-term-abc" })
            await Session.create({ title: "other-session-xyz" })

            const sessions = [...Session.list({ search: "unique-search" })]
            const titles = sessions.map((s) => s.title)

            expect(titles).toContain("unique-search-term-abc")
            expect(titles).not.toContain("other-session-xyz")
          },
        }),
    })
  })

  test("respects limit parameter", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            await Session.create({ title: "session-1" })
            await Session.create({ title: "session-2" })
            await Session.create({ title: "session-3" })

            const sessions = [...Session.list({ limit: 2 })]
            expect(sessions.length).toBe(2)
          },
        }),
    })
  })

  test("returns one session status", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            SessionStatus.set(session.id, { type: "running" })
            const app = Server.Default()

            const response = await app.request(`/session/${session.id}/status`)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ type: "running" })

            SessionStatus.set(session.id, { type: "idle" })
            await Session.remove(session.id)
          },
        }),
    })
  })

  test("dismisses error status without abort route", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace"),
          fn: async () => {
            const session = await Session.create({})
            SessionStatus.set(session.id, { type: "error", message: "boom" })
            const app = Server.Default()

            const response = await app.request(`/session/${session.id}/status/dismiss`, {
              method: "POST",
            })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ type: "idle" })
            expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("OpenAPI includes one session status path", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const specs = await Server.openapi()
        expect(specs.paths["/session/{sessionID}/status"]?.get?.operationId).toBe("session.getStatus")
        expect(specs.paths["/session/{sessionID}/status/dismiss"]?.post?.operationId).toBe("session.dismissStatus")
      },
    })
  })
})
