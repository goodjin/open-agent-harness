import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Log } from "../../src/util/log"
import { ForbiddenError } from "../../src/storage/db"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("Session workspace binding", () => {
  test("Session.create requires workspaceID via WorkspaceContext", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Without WorkspaceContext, create should throw
        await expect(Session.create({})).rejects.toThrow("workspaceID is required")
      },
    })
  })

  test("Session.create uses WorkspaceContext.workspaceID when not provided", async () => {
    const workspaceID = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID,
          fn: async () => {
            const session = await Session.create({})
            expect(session.workspaceID).toBe(workspaceID)
            await Session.remove(session.id)
          },
        }),
    })
  })

  test("Session.create accepts explicit workspaceID", async () => {
    const workspaceID = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({ workspaceID })
        expect(session.workspaceID).toBe(workspaceID)
        await Session.remove(session.id)
      },
    })
  })

  test("Session.get returns session within same workspace", async () => {
    const workspaceID = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID,
          fn: async () => {
            const session = await Session.create({})
            const retrieved = await Session.get(session.id)
            expect(retrieved.id).toBe(session.id)
            expect(retrieved.workspaceID).toBe(workspaceID)
            await Session.remove(session.id)
          },
        }),
    })
  })

  test("Session.get throws ForbiddenError for cross-workspace access", async () => {
    const workspaceID1 = WorkspaceID.ascending()
    const workspaceID2 = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Create session in workspace1
        const session = await Session.create({ workspaceID: workspaceID1 })

        // Try to access from workspace2
        await WorkspaceContext.provide({
          workspaceID: workspaceID2,
          fn: async () => {
            await expect(Session.get(session.id)).rejects.toThrow(ForbiddenError)
          },
        })

        await Session.remove(session.id)
      },
    })
  })

  test("Session.list filters by workspace", async () => {
    const workspaceID1 = WorkspaceID.ascending()
    const workspaceID2 = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Create session in workspace1
        let session1Id: SessionID | undefined
        await WorkspaceContext.provide({
          workspaceID: workspaceID1,
          fn: async () => {
            const session1 = await Session.create({})
            session1Id = session1.id
          },
        })
        if (!session1Id) throw new Error("session1Id not set")

        // Create session in workspace2
        let session2Id: SessionID | undefined
        await WorkspaceContext.provide({
          workspaceID: workspaceID2,
          fn: async () => {
            const session2 = await Session.create({})
            session2Id = session2.id
          },
        })
        if (!session2Id) throw new Error("session2Id not set")

        // List from workspace1 - should only see workspace1 sessions
        await WorkspaceContext.provide({
          workspaceID: workspaceID1,
          fn: async () => {
            const sessions1 = [...Session.list({})]
            const ids1 = sessions1.map((s) => s.id)
            expect(ids1).toContain(session1Id!)
            expect(ids1).not.toContain(session2Id!)
          },
        })

        // List from workspace2 - should only see workspace2 sessions
        await WorkspaceContext.provide({
          workspaceID: workspaceID2,
          fn: async () => {
            const sessions2 = [...Session.list({})]
            const ids2 = sessions2.map((s) => s.id)
            expect(ids2).not.toContain(session1Id!)
            expect(ids2).toContain(session2Id!)
          },
        })

        // Cleanup
        await Session.remove(session1Id)
        await Session.remove(session2Id)
      },
    })
  })

  test("Session.list returns all sessions when no workspace context", async () => {
    const workspaceID = WorkspaceID.ascending()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Create session with workspace
        const session = await Session.create({ workspaceID })

        // List without workspace context (like listGlobal)
        const sessions = [...Session.list({})]
        const ids = sessions.map((s) => s.id)
        expect(ids).toContain(session.id)

        await Session.remove(session.id)
      },
    })
  })
})

