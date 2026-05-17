import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { tmpdir } from "../fixture/fixture"

describe("workflow routes", () => {
  test("lists, creates, reads status, and aborts workflow runs", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    const root = path.join(tmp.path, ".opencode", "workflows")
    await fs.mkdir(root, { recursive: true })
    await Bun.write(
      path.join(root, "route.json"),
      JSON.stringify({
        id: "route",
        name: "Route",
        steps: [{ id: "ask", wait: "user" }],
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}`

            const listed = await app.request(`/workflow?${query}`)
            expect(listed.status).toBe(200)
            expect(((await listed.json()) as Array<{ id: string }>).map((item) => item.id)).toContain("route")

            const created = await app.request(`/workflow/run?${query}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionID: session.id, workflowID: "route" }),
            })
            expect(created.status).toBe(200)
            expect(((await created.json()) as { status: string }).status).toBe("waiting_user")

            const status = await app.request(`/workflow/${session.id}/status?${query}`)
            expect(status.status).toBe(200)
            expect(((await status.json()) as { current: string }).current).toBe("ask")

            const aborted = await app.request(`/workflow/${session.id}/abort?${query}`, {
              method: "POST",
            })
            expect(aborted.status).toBe(200)
            expect(((await aborted.json()) as { status: string }).status).toBe("aborted")
          },
        }),
    })
  })

  test("allows workflow run access in same directory without workspace", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    const other = WorkspaceID.ascending()
    const root = path.join(tmp.path, ".opencode", "workflows")
    await fs.mkdir(root, { recursive: true })
    await Bun.write(
      path.join(root, "guard.json"),
      JSON.stringify({
        id: "guard",
        name: "Guard",
        steps: [{ id: "ask", wait: "user" }],
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const app = Server.Default()
            const scoped = `directory=${encodeURIComponent(tmp.path)}&workspace=${space}`
            const cross = `directory=${encodeURIComponent(tmp.path)}&workspace=${other}`
            const bare = `directory=${encodeURIComponent(tmp.path)}`

            expect(
              await app.request(`/workflow/run?${scoped}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionID: session.id, workflowID: "guard" }),
              }),
            ).toHaveProperty("status", 200)

            expect((await app.request(`/workflow/${session.id}/status?${cross}`)).status).toBe(200)
            expect((await app.request(`/workflow/${session.id}/status?${bare}`)).status).toBe(200)

            expect(
              (
                await app.request(`/workflow/run?${cross}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ sessionID: session.id, workflowID: "guard" }),
                })
              ).status,
            ).toBe(200)
            expect(
              (
                await app.request(`/workflow/run?${bare}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ sessionID: session.id, workflowID: "guard" }),
                })
              ).status,
            ).toBe(200)

            expect(
              (
                await app.request(`/workflow/resume?${cross}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ sessionID: session.id, variables: { value: true } }),
                })
              ).status,
            ).toBe(200)
            expect(
              (
                await app.request(`/workflow/resume?${bare}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ sessionID: session.id, variables: { value: true } }),
                })
              ).status,
            ).toBe(200)

            expect(
              (
                await app.request(`/workflow/${session.id}/abort?${cross}`, {
                  method: "POST",
                })
              ).status,
            ).toBe(200)
            expect(
              (
                await app.request(`/workflow/${session.id}/abort?${bare}`, {
                  method: "POST",
                })
              ).status,
            ).toBe(200)
          },
        }),
    })
  })

  test("lists workflow runs from the current directory only", async () => {
    await using one = await tmpdir()
    await using two = await tmpdir()
    const space = WorkspaceID.ascending()
    const other = WorkspaceID.ascending()
    const app = Server.Default()

    for (const dir of [one.path, two.path]) {
      const root = path.join(dir, ".opencode", "workflows")
      await fs.mkdir(root, { recursive: true })
      await Bun.write(
        path.join(root, "run.json"),
        JSON.stringify({
          id: "run",
          name: "Run",
          steps: [{ id: "done" }],
        }),
      )
    }

    let keep = ""
    let skip = ""
    let away = ""

    await Instance.provide({
      directory: one.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            keep = session.id
            await WorkflowExecutor.run({ sessionID: session.id, workflowID: "run", variables: { session: session.id } })
          },
        }),
    })
    await Instance.provide({
      directory: one.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: other,
          fn: async () => {
            const session = await Session.create({})
            skip = session.id
            await WorkflowExecutor.run({ sessionID: session.id, workflowID: "run", variables: { session: session.id } })
          },
        }),
    })
    await Instance.provide({
      directory: two.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            away = session.id
            await WorkflowExecutor.run({ sessionID: session.id, workflowID: "run", variables: { session: session.id } })
          },
        }),
    })

    const listed = await Instance.provide({
      directory: one.path,
      fn: async () => (await (await app.request("/workflow/run")).json()) as Array<{ runID: string }>,
    })
    expect(listed).toHaveLength(2)
    expect(JSON.stringify(listed)).toContain(keep)
    expect(JSON.stringify(listed)).toContain(skip)
    expect(JSON.stringify(listed)).not.toContain(away)

    const current = await Instance.provide({
      directory: one.path,
      fn: async () => (await (await app.request("/workflow/run")).json()) as Array<{ runID: string }>,
    })
    expect(JSON.stringify(current)).toContain(keep)
    expect(JSON.stringify(current)).toContain(skip)
  })

  test("generated OpenAPI includes workflow operations", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()
    const paths = spec.paths as Record<
      string,
      {
        get?: { operationId?: string }
        post?: { operationId?: string; requestBody?: { required?: boolean } }
      }
    >

    expect(paths["/workflow"]?.get?.operationId).toBe("workflow.list")
    expect(paths["/workflow/run"]?.post?.operationId).toBe("workflow.run")
    expect(paths["/workflow/run"]?.post?.requestBody?.required).toBe(true)
    expect(paths["/workflow/resume"]?.post?.requestBody?.required).toBe(true)
    expect(paths["/workflow/{sessionID}/status"]?.get?.operationId).toBe("workflow.status")
    expect(paths["/workflow/{sessionID}/abort"]?.post?.operationId).toBe("workflow.abort")
  })
})
