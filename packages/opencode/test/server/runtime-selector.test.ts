import { afterEach, describe, expect, mock, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { installAdaptor } from "../../src/control-plane/adaptors"
import type { Adaptor } from "../../src/control-plane/types"
import { Flag } from "../../src/flag/flag"
import { PermissionNext } from "../../src/permission/next"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { Database } from "../../src/storage/db"
import { Session } from "../../src/session"
import { Audit } from "../../src/observability/audit"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

afterEach(async () => {
  mock.restore()
  // @ts-expect-error test toggles an experimental runtime flag
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
  await resetDatabase()
  await Instance.disposeAll()
})

function header(dir: string) {
  return {
    "content-type": "application/json",
    "x-opencode-directory": dir,
  }
}

describe("server runtime selectors", () => {
  test("ignores legacy workspace query and header on ordinary API routes", async () => {
    await using tmp = await tmpdir({ git: true })
    // @ts-expect-error test toggles an experimental runtime flag
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    const calls: string[] = []
    const adaptor: Adaptor = {
      configure: (cfg) => cfg,
      create: async () => {},
      remove: async () => {},
      fetch: async (_cfg, input) => {
        calls.push(input.toString())
        return new Response("proxied", { status: 202 })
      },
    }
    installAdaptor("selector-test", adaptor)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const project = Instance.project
        const space = WorkspaceID.ascending()
        Database.use((db) =>
          db
            .insert(WorkspaceTable)
            .values({
              id: space,
              branch: "main",
              project_id: project.id,
              type: "selector-test",
              name: "remote",
            })
            .run(),
        )

        const session = await Session.create({})
        const app = Server.createApp({})
        const list = await app.request(`/session?workspace=${space}`)
        const perm = await app.request("/permission", {
          headers: {
            "x-opencode-workspace": space,
          },
        })

        expect(list.status).toBe(200)
        expect(((await list.json()) as Session.Info[]).map((item) => item.id)).toContain(session.id)
        expect(perm.status).toBe(200)
        expect(calls).toEqual([])
      },
    })
  })

  test("rejects legacy directory selectors for another worktree in the same project", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.createApp({})
    const wt = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-selector`)
    await $`git worktree add ${wt} -b mod17-${Date.now()}`.cwd(tmp.path).quiet()

    try {
      await fs.mkdir(path.join(wt, ".opencode", "workflows"), { recursive: true })
      await Bun.write(
        path.join(wt, ".opencode", "workflows", "b.json"),
        JSON.stringify({
          id: "b",
          name: "B",
          steps: [{ id: "done" }],
        }),
      )

      const project = await Instance.provide({
        directory: tmp.path,
        fn: () => Promise.resolve(Instance.project),
      })
      const same = await Project.fromDirectory(wt)
      expect(same.project.id).toBe(project.id)

      const session = await Instance.provide({
        directory: wt,
        fn: async () => {
          const item = await Session.create({})
          await Audit.emit({
            sessionID: item.id,
            event: { type: "restore.completed", hash: "b" },
          })
          await WorkflowExecutor.run({ sessionID: item.id, workflowID: "b" })
          PermissionNext.ask({
            id: PermissionID.make("per_selector_b"),
            sessionID: item.id,
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
            ruleset: [],
          }).catch(() => undefined)
          await Bun.sleep(0)
          return item
        },
      })

      const urls = [
        "/session",
        `/session/${session.id}`,
        `/session/${session.id}/status`,
        "/file/status",
        "/permission",
        "/audit",
        "/workflow/run",
      ]

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          for (const url of urls) {
            expect((await app.request(`${url}?directory=${encodeURIComponent(wt)}`)).status).toBe(403)
            expect((await app.request(url, { headers: header(wt) })).status).toBe(403)
          }
        },
      })

      await Instance.provide({
        directory: wt,
        fn: () => PermissionNext.reply({ requestID: PermissionID.make("per_selector_b"), reply: "reject" }),
      })
    } finally {
      await $`git worktree remove --force ${wt}`.cwd(tmp.path).quiet().nothrow()
    }
  })
})
