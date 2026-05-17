import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Log } from "../../src/util/log"
import { ForbiddenError } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("Session directory workspace binding", () => {
  test("Session.create does not require workspaceID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        expect(session.workspaceID).toBeUndefined()
        await Session.remove(session.id)
      },
    })
  })

  test("WorkspaceContext does not stamp new sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            expect(session.workspaceID).toBeUndefined()
            await Session.remove(session.id)
          },
        }),
    })
  })

  test("legacy workspaceID sessions load by directory without workspace context", async () => {
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.createNext({
          directory: Instance.directory,
          workspaceID: space,
        })
        const item = await Session.get(session.id)
        expect(item.id).toBe(session.id)
        expect(item.workspaceID).toBe(space)
        await Session.remove(session.id)
      },
    })
  })

  test("Session.get rejects cross-directory access regardless of legacy workspaceID", async () => {
    await using tmp = await tmpdir({ git: true })
    const other = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-other`)
    const space = WorkspaceID.ascending()
    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Session.createNext({
          directory: Instance.directory,
          workspaceID: space,
        }),
    })

    await Instance.provide({
      directory: other,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            await expect(Session.get(session.id)).rejects.toThrow(ForbiddenError)
          },
        }),
    })
  })

  test("Session.list ignores legacy workspaceID and stays in current directory", async () => {
    const one = WorkspaceID.ascending()
    const two = WorkspaceID.ascending()
    await using tmp = await tmpdir({ git: true })
    const other = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-other`)

    const first = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.createNext({ directory: Instance.directory, workspaceID: one }),
    })
    const second = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.createNext({ directory: Instance.directory, workspaceID: two }),
    })
    const third = await Instance.provide({
      directory: other,
      fn: async () => Session.createNext({ directory: Instance.directory, workspaceID: one }),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = [...Session.list({})].map((session) => session.id)
        expect(ids).toContain(first.id)
        expect(ids).toContain(second.id)
        expect(ids).not.toContain(third.id)
      },
    })
  })

  test("Session.fork rejects same legacy workspace session from another worktree directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const wt = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-wt`)
    await $`git worktree add ${wt} -b fork-${Date.now()}`.cwd(tmp.path).quiet()

    try {
      const space = WorkspaceID.ascending()
      const session = await Instance.provide({
        directory: tmp.path,
        fn: async () => Session.createNext({ directory: Instance.directory, workspaceID: space }),
      })

      await Instance.provide({
        directory: wt,
        fn: async () => {
          await expect(Session.fork({ sessionID: session.id })).rejects.toThrow(ForbiddenError)
        },
      })
    } finally {
      await $`git worktree remove --force ${wt}`.cwd(tmp.path).quiet().nothrow()
    }
  })
})
