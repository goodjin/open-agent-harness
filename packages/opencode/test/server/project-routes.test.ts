import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
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

function headers(dir: string, space?: WorkspaceID) {
  return {
    "content-type": "application/json",
    "x-opencode-directory": dir,
    ...(space ? { "x-opencode-workspace": space } : {}),
  }
}

async function current(app: ReturnType<typeof Server.Default>, dir: string) {
  const res = await call(app, dir, "/project/current")
  expect(res.status).toBe(200)
  return (await res.json()) as Project.Info
}

async function call(app: ReturnType<typeof Server.Default>, dir: string, input: RequestInfo | URL, init?: RequestInit) {
  return Instance.provide({
    directory: dir,
    fn: () =>
      app.request(input, {
        ...init,
        headers: {
          ...headers(dir),
          ...(init?.headers as Record<string, string> | undefined),
        },
      }),
  })
}

describe("project routes", () => {
  test("lists projects visible to the current instance", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const project = await current(app, tmp.path)

    const res = await call(app, tmp.path, "/project")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Project.Info[]

    expect(body.map((item) => item.id)).toContain(project.id)
  })

  test("initializes current project and returns its id", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const project = await current(app, tmp.path)

    const res = await call(app, tmp.path, "/project/init", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Project.Info

    expect(body.id).toBe(project.id)
    expect(typeof body.time.initialized).toBe("number")
  })

  test("creates, lists, and gets project-scoped sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const project = await current(app, tmp.path)

    const created = await call(app, tmp.path, `/project/${project.id}/session`, {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(200)
    const session = (await created.json()) as Session.Info

    expect(session.projectID).toBe(project.id)
    expect(session.workspaceID).toBeUndefined()
    expect(session.directory).toBe(tmp.path)

    const listed = await call(app, tmp.path, `/project/${project.id}/session`)
    expect(listed.status).toBe(200)
    const list = (await listed.json()) as Session.Info[]
    expect(list.map((item) => item.id)).toContain(session.id)

    const got = await call(app, tmp.path, `/project/${project.id}/session/${session.id}`)
    expect(got.status).toBe(200)
    expect(((await got.json()) as Session.Info).id).toBe(session.id)
  })

  test("ignores deprecated project session workspaceID body", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const project = await current(app, tmp.path)

    const res = await call(app, tmp.path, `/project/${project.id}/session`, {
      method: "POST",
      body: JSON.stringify({ workspaceID: WorkspaceID.ascending() }),
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as Session.Info).workspaceID).toBeUndefined()
  })

  test("forbids cross-project session access but ignores workspace header", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })
    const app = Server.Default()
    const first = await current(app, one.path)
    const second = await current(app, two.path)
    const space = WorkspaceID.ascending()
    const other = WorkspaceID.ascending()

    const created = await call(app, one.path, `/project/${first.id}/session`, {
      method: "POST",
      headers: headers(one.path, space),
      body: JSON.stringify({}),
    })
    const session = (await created.json()) as Session.Info

    const cross = await call(app, two.path, `/project/${second.id}/session/${session.id}`, {
      headers: headers(two.path, space),
    })
    expect(cross.status).toBe(403)

    const wrong = await call(app, one.path, `/project/${first.id}/session/${session.id}`, {
      headers: headers(one.path, other),
    })
    expect(wrong.status).toBe(200)
  })

  test("forbids dsl_context updates outside the bound directory", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })
    const app = Server.Default()
    const project = await current(app, one.path)
    const space = WorkspaceID.ascending()
    const other = WorkspaceID.ascending()

    const res = await call(app, one.path, `/project/${project.id}/session`, {
      method: "POST",
      headers: headers(one.path, space),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const session = (await res.json()) as Session.Info

    const ok = await call(app, one.path, `/session/${session.id}/dsl_context`, {
      method: "PATCH",
      headers: headers(one.path, space),
      body: JSON.stringify({ dsl_context: { workflow: { status: "ok" } } }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as Session.Info).dsl_context).toEqual({ workflow: { status: "ok" } })

    const cross = await call(app, one.path, `/session/${session.id}/dsl_context`, {
      method: "PATCH",
      headers: headers(one.path, other),
      body: JSON.stringify({ dsl_context: { workflow: { status: "cross" } } }),
    })
    expect(cross.status).toBe(200)

    const bare = await call(app, one.path, `/session/${session.id}/dsl_context`, {
      method: "PATCH",
      body: JSON.stringify({ dsl_context: { workflow: { status: "bare" } } }),
    })
    expect(bare.status).toBe(200)

    const away = await call(app, two.path, `/session/${session.id}/dsl_context`, {
      method: "PATCH",
      headers: headers(two.path, space),
      body: JSON.stringify({ dsl_context: { workflow: { status: "away" } } }),
    })
    expect(away.status).toBe(403)
  })

  test("OpenAPI marks session dsl_context 403 responses", async () => {
    const spec = (await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()) as {
      paths: Record<string, { patch?: { responses?: Record<string, unknown> } }>
    }

    expect(spec.paths["/session/{sessionID}/dsl_context"]?.patch?.responses?.["403"]).toBeDefined()
  })

  test("keeps directory query compatibility while project-scoped list is preferred", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const project = await current(app, tmp.path)
    const space = WorkspaceID.ascending()

    const created = await call(app, tmp.path, `/project/${project.id}/session`, {
      method: "POST",
      headers: headers(tmp.path, space),
      body: JSON.stringify({}),
    })
    const session = (await created.json()) as Session.Info

    const old = await call(app, tmp.path, `/session?directory=${encodeURIComponent(tmp.path)}`, {
      headers: headers(tmp.path, space),
    })
    expect(old.status).toBe(200)
    expect(((await old.json()) as Session.Info[]).map((item) => item.id)).toContain(session.id)

    const next = await call(app, tmp.path, `/project/${project.id}/session`, {
      headers: headers(tmp.path, space),
    })
    expect(next.status).toBe(200)
    expect(((await next.json()) as Session.Info[]).map((item) => item.id)).toContain(session.id)
  })

  test("isolates project session files and status across worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const wt = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-wt`)
    await $`git worktree add ${wt} -b mod10-${Date.now()}`.cwd(tmp.path).quiet()

    try {
      const project = await current(app, tmp.path)
      const same = await current(app, wt)
      const first = WorkspaceID.ascending()
      const second = WorkspaceID.ascending()

      expect(same.id).toBe(project.id)

      const ares = await call(app, tmp.path, `/project/${project.id}/session`, {
        method: "POST",
        headers: headers(tmp.path, first),
        body: JSON.stringify({}),
      })
      const bres = await call(app, wt, `/project/${project.id}/session`, {
        method: "POST",
        headers: headers(wt, second),
        body: JSON.stringify({}),
      })
      const a = (await ares.json()) as Session.Info
      const b = (await bres.json()) as Session.Info

      await Bun.write(path.join(tmp.path, "main-only.txt"), "main\n")
      await Bun.write(path.join(wt, "worktree-only.txt"), "worktree\n")

      const status = await call(app, tmp.path, `/project/${project.id}/session/${a.id}/file/status`, {
        headers: headers(tmp.path, first),
      })
      expect(status.status).toBe(200)
      const files = (await status.json()) as { path: string }[]
      expect(files.map((file) => file.path)).toContain("main-only.txt")
      expect(files.map((file) => file.path)).not.toContain("worktree-only.txt")

      const other = await call(app, wt, `/project/${project.id}/session/${b.id}/file/status`, {
        headers: headers(wt, second),
      })
      expect(other.status).toBe(200)
      const paths = ((await other.json()) as { path: string }[]).map((file) => file.path)
      expect(paths).toContain("worktree-only.txt")
      expect(paths).not.toContain("main-only.txt")

      const cross = await call(app, wt, `/project/${project.id}/session/${a.id}/file/status`, {
        headers: headers(wt, second),
      })
      expect(cross.status).toBe(403)

      const mixed = await call(app, wt, `/project/${project.id}/session/${a.id}/file/status`, {
        headers: headers(wt, first),
      })
      expect(mixed.status).toBe(403)
    } finally {
      await $`git worktree remove --force ${wt}`.cwd(tmp.path).quiet().nothrow()
    }
  })

  test("binds project session list get and status to the current worktree directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const wt = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-wt`)
    await $`git worktree add ${wt} -b mod10-${Date.now()}`.cwd(tmp.path).quiet()

    try {
      const project = await current(app, tmp.path)
      const same = await current(app, wt)
      const space = WorkspaceID.ascending()

      expect(same.id).toBe(project.id)

      const ares = await call(app, tmp.path, `/project/${project.id}/session`, {
        method: "POST",
        headers: headers(tmp.path, space),
        body: JSON.stringify({}),
      })
      const bres = await call(app, wt, `/project/${project.id}/session`, {
        method: "POST",
        headers: headers(wt, space),
        body: JSON.stringify({}),
      })
      const a = (await ares.json()) as Session.Info
      const b = (await bres.json()) as Session.Info

      const list = await call(app, tmp.path, `/project/${project.id}/session`, {
        headers: headers(tmp.path, space),
      })
      expect(list.status).toBe(200)
      const ids = ((await list.json()) as Session.Info[]).map((item) => item.id)
      expect(ids).toContain(a.id)
      expect(ids).not.toContain(b.id)

      const raw = `${wt}/../${path.basename(wt)}`
      const old = await call(app, tmp.path, `/project/${project.id}/session?directory=${encodeURIComponent(raw)}`, {
        headers: headers(tmp.path, space),
      })
      expect(old.status).toBe(403)

      const get = await call(app, tmp.path, `/project/${project.id}/session/${b.id}`, {
        headers: headers(tmp.path, space),
      })
      expect(get.status).toBe(403)

      const status = await call(app, tmp.path, `/project/${project.id}/session/${b.id}/status`, {
        headers: headers(tmp.path, space),
      })
      expect(status.status).toBe(403)

      const ok = await call(app, wt, `/project/${project.id}/session/${b.id}/status`, {
        headers: headers(wt, space),
      })
      expect(ok.status).toBe(200)
    } finally {
      await $`git worktree remove --force ${wt}`.cwd(tmp.path).quiet().nothrow()
    }
  })

  test("OpenAPI includes project init and project session paths", async () => {
    const spec = (await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()) as {
      paths: Record<string, { get?: { operationId?: string }; post?: { operationId?: string } }>
    }

    expect(spec.paths["/project/init"]?.post?.operationId).toBe("project.init")
    expect(spec.paths["/project/{projectID}/session"]?.get?.operationId).toBe("project.session.list")
    expect(spec.paths["/project/{projectID}/session"]?.post?.operationId).toBe("project.session.create")
    expect(spec.paths["/project/{projectID}/session/{sessionID}"]?.get?.operationId).toBe("project.session.get")
  })
})
