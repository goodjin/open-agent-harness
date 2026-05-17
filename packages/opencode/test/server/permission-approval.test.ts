import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { PermissionNext } from "../../src/permission/next"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

async function waitForPending(count: number) {
  for (let i = 0; i < 20; i++) {
    const list = await PermissionNext.list({ all: true })
    if (list.length === count) return list
    await Bun.sleep(0)
  }
  return PermissionNext.list({ all: true })
}

describe("permission approval routes", () => {
  test("lists pending approvals by session in current directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const session = await Session.create({})
            const other = await Session.create({})
            const asks = [
              PermissionNext.ask({
                id: PermissionID.make("per_route_list_a"),
                sessionID: session.id,
                permission: "bash",
                patterns: ["ls"],
                metadata: {},
                always: [],
                ruleset: [],
              }).catch(() => undefined),
              PermissionNext.ask({
                id: PermissionID.make("per_route_list_b"),
                sessionID: other.id,
                permission: "bash",
                patterns: ["pwd"],
                metadata: {},
                always: [],
                ruleset: [],
              }).catch(() => undefined),
            ]
            await Bun.sleep(0)

            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_test`
            const res = await app.request(`/permission/session/${session.id}?${query}`)
            expect(res.status).toBe(200)
            const body = await res.json()
            expect(body.map((item: { id: string }) => item.id)).toEqual(["per_route_list_a"])

            await PermissionNext.reply({ requestID: PermissionID.make("per_route_list_a"), reply: "reject" })
            await PermissionNext.reply({ requestID: PermissionID.make("per_route_list_b"), reply: "reject" })
            await Promise.all(asks)
          },
        }),
    })
  })

  test("reply route covers once, always, reject, and feedback", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const session = await Session.create({})
            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_test`

            const once = PermissionNext.ask({
              id: PermissionID.make("per_route_once"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["ls"],
              metadata: {},
              always: [],
              ruleset: [],
            })
            await Bun.sleep(0)
            const onceRes = await app.request(`/permission/per_route_once/reply?${query}`, {
              method: "POST",
              body: JSON.stringify({ reply: "once" }),
              headers: { "content-type": "application/json" },
            })
            expect(onceRes.status).toBe(200)
            await expect(once).resolves.toBeUndefined()

            const always = PermissionNext.ask({
              id: PermissionID.make("per_route_always"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: {},
              always: ["pwd"],
              ruleset: [],
            })
            const match = PermissionNext.ask({
              id: PermissionID.make("per_route_match"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: {},
              always: [],
              ruleset: [],
            })
            await Bun.sleep(0)
            const alwaysRes = await app.request(`/permission/per_route_always/reply?${query}`, {
              method: "POST",
              body: JSON.stringify({ reply: "always" }),
              headers: { "content-type": "application/json" },
            })
            expect(alwaysRes.status).toBe(200)
            await expect(always).resolves.toBeUndefined()
            await expect(match).resolves.toBeUndefined()

            const reject = PermissionNext.ask({
              id: PermissionID.make("per_route_reject"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["rm"],
              metadata: {},
              always: [],
              ruleset: [],
            })
            await Bun.sleep(0)
            await app.request(`/permission/per_route_reject/reply?${query}`, {
              method: "POST",
              body: JSON.stringify({ reply: "reject", message: "Use ls instead" }),
              headers: { "content-type": "application/json" },
            })
            await expect(reject).rejects.toBeInstanceOf(PermissionNext.CorrectedError)
          },
        }),
    })
  })

  test("reply route returns not found for unknown request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default()
        const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_test`
        const res = await app.request(`/permission/per_route_unknown/reply?${query}`, {
          method: "POST",
          body: JSON.stringify({ reply: "once" }),
          headers: { "content-type": "application/json" },
        })
        expect(res.status).toBe(404)
      },
    })
  })

  test("OpenAPI marks permission reply forbidden response", async () => {
    const spec = (await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()) as {
      paths: Record<string, { post?: { responses?: Record<string, unknown> } }>
    }

    expect(spec.paths["/permission/{requestID}/reply"]?.post?.responses?.["403"]).toBeDefined()
  })

  test("deprecated session reply route returns not found for unknown request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const session = await Session.create({})
            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_test`
            const res = await app.request(`/session/${session.id}/permissions/per_route_session_unknown?${query}`, {
              method: "POST",
              body: JSON.stringify({ response: "once" }),
              headers: { "content-type": "application/json" },
            })
            expect(res.status).toBe(404)
          },
        }),
    })
  })

  test("deprecated session reply route forbids request from another session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const session = await Session.create({})
            const other = await Session.create({})
            const ask = PermissionNext.ask({
              id: PermissionID.make("per_route_session_mismatch"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["ls"],
              metadata: {},
              always: [],
              ruleset: [],
            }).catch((err) => err)
            await waitForPending(1)

            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_test`
            const res = await app.request(`/session/${other.id}/permissions/per_route_session_mismatch?${query}`, {
              method: "POST",
              body: JSON.stringify({ response: "once" }),
              headers: { "content-type": "application/json" },
            })
            expect(res.status).toBe(403)
            expect((await PermissionNext.list({ all: true })).map((item) => item.id)).toEqual([
              PermissionID.make("per_route_session_mismatch"),
            ])

            await PermissionNext.reply({ requestID: PermissionID.make("per_route_session_mismatch"), reply: "reject" })
            expect(await ask).toBeInstanceOf(PermissionNext.RejectedError)
          },
        }),
    })
  })

  test("reply route ignores legacy workspace query in same directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const workspaceID = WorkspaceID.make("wrk_a")
        const ask = WorkspaceContext.provide({
          workspaceID,
          fn: async () => {
            const session = await Session.create({})
            return PermissionNext.ask({
              id: PermissionID.make("per_route_workspace"),
              sessionID: session.id,
              workspaceID,
              permission: "bash",
              patterns: ["ls"],
              metadata: {},
              always: [],
              ruleset: [],
            })
          },
        }).catch((err) => err)
        await waitForPending(1)

        const app = Server.Default()
        const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_b`
        const res = await app.request(`/permission/per_route_workspace/reply?${query}`, {
          method: "POST",
          body: JSON.stringify({ reply: "once" }),
          headers: { "content-type": "application/json" },
        })
        expect(res.status).toBe(200)
        expect(await ask).toBeUndefined()
      },
    })
  })

  test("deprecated session reply route ignores legacy workspace query in same directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const workspaceID = WorkspaceID.make("wrk_session_a")
        const data = await WorkspaceContext.provide({
          workspaceID,
          fn: async () => {
            const session = await Session.create({})
            const ask = PermissionNext.ask({
              id: PermissionID.make("per_route_session_workspace"),
              sessionID: session.id,
              workspaceID,
              permission: "bash",
              patterns: ["ls"],
              metadata: {},
              always: [],
              ruleset: [],
            }).catch((err) => err)
            return { ask, session }
          },
        })
        await waitForPending(1)

        const app = Server.Default()
        const query = `directory=${encodeURIComponent(tmp.path)}&workspace=wrk_session_b`
        const res = await app.request(`/session/${data.session.id}/permissions/per_route_session_workspace?${query}`, {
          method: "POST",
          body: JSON.stringify({ response: "once" }),
          headers: { "content-type": "application/json" },
        })
        expect(res.status).toBe(200)
        expect(await data.ask).toBeUndefined()
      },
    })
  })

  test("list route shows requests in current directory without workspace context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const workspaceID = WorkspaceID.make("wrk_list_hidden")
        const ask = WorkspaceContext.provide({
          workspaceID,
          fn: async () => {
            const session = await Session.create({})
            return PermissionNext.ask({
              id: PermissionID.make("per_route_hidden"),
              sessionID: session.id,
              workspaceID,
              permission: "bash",
              patterns: ["ls"],
              metadata: {},
              always: [],
              ruleset: [],
            })
          },
        }).catch((err) => err)
        await waitForPending(1)

        const app = Server.Default()
        const res = await app.request(`/permission?directory=${encodeURIComponent(tmp.path)}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([expect.objectContaining({ id: PermissionID.make("per_route_hidden") })])

        const result = await WorkspaceContext.provide({
          workspaceID,
          fn: () => PermissionNext.reply({ requestID: PermissionID.make("per_route_hidden"), reply: "reject" }),
        })
        expect(result).toEqual({ type: "applied" })
        expect(await ask).toBeInstanceOf(PermissionNext.RejectedError)
      },
    })
  })
})
