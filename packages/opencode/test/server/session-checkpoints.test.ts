import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { Snapshot } from "../../src/snapshot"
import { tmpdir } from "../fixture/fixture"

async function checkpoint(session: Session.Info, hash: string) {
  const msg = MessageID.ascending()
  await Session.updateMessage({
    id: msg,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg,
    sessionID: session.id,
    type: "step-start",
    snapshot: hash,
  })
}

describe("session checkpoint endpoints", () => {
  test("does not list checkpoints across workspace directories", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })
    const hash = "leaked-checkpoint-hash"
    const workspace = WorkspaceID.ascending()
    let id: Session.Info["id"] | undefined

    await Instance.provide({
      directory: one.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: workspace,
          fn: async () => {
            const session = await Session.createNext({ directory: Instance.directory, workspaceID: workspace })
            id = session.id
            const msg = MessageID.ascending()
            await Session.updateMessage({
              id: msg,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "user",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: msg,
              sessionID: session.id,
              type: "step-start",
              snapshot: hash,
              permission: [{ permission: "edit", pattern: "*", action: "allow" }],
              dsl_context: { secret: "value" },
            })
          },
        }),
    })
    if (!id) throw new Error("session id missing")
    const sid = id

    const app = Server.Default()
    const res = await app.request(`/session/${sid}/checkpoints?directory=${encodeURIComponent(two.path)}`)
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).not.toContain(hash)
    expect(text).not.toContain("permission")
    expect(text).not.toContain("dsl_context")

    await Instance.provide({
      directory: one.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: workspace,
          fn: async () => {
            await Session.remove(sid)
          },
        }),
    })
  })

  test("allows legacy workspace checkpoints without workspace in same directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const file = path.join(tmp.path, "workspace.txt")
            await Bun.write(file, "before\n")
            const hash = await Snapshot.track()
            if (!hash) throw new Error("snapshot hash missing")
            const session = await Session.createNext({ directory: Instance.directory, workspaceID: space })
            await checkpoint(session, hash)
            await Bun.write(file, "after\n")

            const app = Server.Default()
            const dir = `directory=${encodeURIComponent(tmp.path)}`
            const listed = await app.request(`/session/${session.id}/checkpoints?${dir}`)
            expect(listed.status).toBe(200)

            const preview = await app.request(`/session/${session.id}/restore/preview?${dir}`, {
              method: "POST",
              body: JSON.stringify({ hash }),
              headers: { "content-type": "application/json" },
            })
            expect(preview.status).toBe(200)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("lists checkpoints, previews restore, restores, and rejects unrelated hashes", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const file = path.join(tmp.path, "route.txt")
            await Bun.write(file, "before\n")
            const hash = await Snapshot.track()
            if (!hash) throw new Error("snapshot hash missing")
            const session = await Session.create({})
            const other = await Session.create({})
            await checkpoint(session, hash)
            await Bun.write(file, "after\n")
            const app = Server.Default()
            const dir = `directory=${encodeURIComponent(tmp.path)}&workspace=${space}`

            const listed = await app.request(`/session/${session.id}/checkpoints?${dir}`)
            expect(listed.status).toBe(200)
            const list = (await listed.json()) as Array<{ hash: string }>
            expect(list.map((item) => item.hash)).toContain(hash)

            const preview = await app.request(`/session/${session.id}/restore/preview?${dir}`, {
              method: "POST",
              body: JSON.stringify({ hash }),
              headers: { "content-type": "application/json" },
            })
            expect(preview.status).toBe(200)
            const body = (await preview.json()) as { files: string[]; diff: string }
            expect(body.files).toContain(file.replaceAll("\\", "/"))
            expect(body.diff).toContain("after")
            expect(await Bun.file(file).text()).toBe("after\n")

            const denied = await app.request(`/session/${other.id}/restore?${dir}`, {
              method: "POST",
              body: JSON.stringify({ hash }),
              headers: { "content-type": "application/json" },
            })
            expect(denied.status).toBe(403)

            const restored = await app.request(`/session/${session.id}/restore?${dir}`, {
              method: "POST",
              body: JSON.stringify({ hash }),
              headers: { "content-type": "application/json" },
            })
            expect(restored.status).toBe(200)
            expect(await Bun.file(file).text()).toBe("before\n")

            const missing = await app.request(`/session/ses_missing/checkpoints?${dir}`)
            expect(missing.status).toBe(404)

            await Session.remove(session.id)
            await Session.remove(other.id)
          },
        }),
    })
  })
  test("generated OpenAPI includes checkpoint preview and forbidden responses", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()
    const paths = spec.paths as Record<
      string,
      {
        get?: { responses?: Record<string, unknown> }
        post?: { operationId?: string; responses?: Record<string, unknown> }
      }
    >

    expect(paths["/session/{sessionID}/restore/preview"]?.post?.operationId).toBe("session.restorePreview")
    expect(paths["/session/{sessionID}/checkpoints"]?.get?.responses?.["403"]).toBeDefined()
    expect(paths["/session/{sessionID}/restore"]?.post?.responses?.["403"]).toBeDefined()
    expect(paths["/session/{sessionID}/restore/preview"]?.post?.responses?.["403"]).toBeDefined()
  })
})
