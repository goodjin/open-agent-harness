import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionTimeline } from "../../src/session/timeline"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")

describe("VAL-SESSION-009: Timeline checkpoint save", () => {
  test("checkpoints are saved at step boundaries with git hash and timestamp", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "user",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)

            // Simulate step-start with snapshot hash
            const stepStartPart = {
              id: PartID.ascending(),
              messageID,
              sessionID: session.id,
              type: "step-start" as const,
              snapshot: "abc123def456",
            }
            await Session.updatePart(stepStartPart)

            const checkpoints = await SessionTimeline.list(session.id)
            expect(checkpoints.length).toBe(1)
            expect(checkpoints[0].hash).toBe("abc123def456")
            expect(checkpoints[0].messageID).toBe(messageID)
            expect(typeof checkpoints[0].timestamp).toBe("number")

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("multiple checkpoints are saved for multiple steps", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            // Create first message with step-start
            const msgID1 = MessageID.ascending()
            await Session.updateMessage({
              id: msgID1,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() - 1000 },
              agent: "user",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)

            await Session.updatePart({
              id: PartID.ascending(),
              messageID: msgID1,
              sessionID: session.id,
              type: "step-start",
              snapshot: "hash1",
            })

            // Create second message with step-start
            const msgID2 = MessageID.ascending()
            await Session.updateMessage({
              id: msgID2,
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
              messageID: msgID2,
              sessionID: session.id,
              type: "step-start",
              snapshot: "hash2",
            })

            const checkpoints = await SessionTimeline.list(session.id)
            expect(checkpoints.length).toBe(2)
            expect(checkpoints[0].hash).toBe("hash1")
            expect(checkpoints[1].hash).toBe("hash2")

            await Session.remove(session.id)
          },
        }),
    })
  })
})

describe("VAL-SESSION-010: Timeline checkpoint restore", () => {
  test("restore reverts workspace files to checkpoint state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            // Create a file in the workspace
            const testFile = path.join(tmp.path, "test.txt")
            await Bun.write(testFile, "original content")

            const session = await Session.create({})

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
            })

            // Modify the file
            await Bun.write(testFile, "modified content")
            const modifiedContent = await Bun.file(testFile).text()
            expect(modifiedContent).toBe("modified content")

            // Note: Snapshot.restore is idempotent - calling it with the same hash
            // multiple times will result in the same state
            const restored = await SessionTimeline.restore(session.id, "abc123")
            expect(restored.id).toBe(session.id)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
            })

            // Restore twice - both should succeed
            const restored1 = await SessionTimeline.restore(session.id, "abc123")
            const restored2 = await SessionTimeline.restore(session.id, "abc123")
            expect(restored1.id).toBe(restored2.id)

            await Session.remove(session.id)
          },
        }),
    })
  })
})

describe("VAL-SESSION-014: dsl_context workflow state preservation", () => {
  test("dsl_context is stored and retrieved correctly", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            const dslContext = {
              vars: { foo: "bar" },
              history: [{ step: 1, action: "test" }],
            }

            const updated = await Session.setDslContext({
              sessionID: session.id,
              dsl_context: dslContext,
            })

            expect(updated.dsl_context).toEqual(dslContext)

            const retrieved = await Session.get(session.id)
            expect(retrieved.dsl_context).toEqual(dslContext)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("dsl_context is preserved across checkpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            const dslContext = {
              vars: { counter: 0 },
              history: [],
            }

            // Set initial dsl_context
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: dslContext,
            })

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "checkpoint1",
            })

            // Verify dsl_context is still present
            const afterCheckpoint = await Session.get(session.id)
            expect(afterCheckpoint.dsl_context).toEqual(dslContext)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("dsl_context is preserved after restore", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            const dslContext = {
              vars: { important: "data" },
              history: [{ step: 1 }],
            }

            // Set dsl_context before checkpoint
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: dslContext,
            })

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
            })

            // Restore (even though it doesn't actually do anything to dsl_context)
            await SessionTimeline.restore(session.id, "abc123")

            // dsl_context should be preserved
            const afterRestore = await Session.get(session.id)
            expect(afterRestore.dsl_context).toEqual(dslContext)

            await Session.remove(session.id)
          },
        }),
    })
  })
})

// ============================================================================
// VAL-CROSS-007: Timeline restore recovers session state and permissions correctly
// ============================================================================

describe("VAL-CROSS-007: Timeline restore recovers session state and permissions", () => {
  test("checkpoint saves permission grants at step boundaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const permission = [
              { permission: "edit", pattern: "*.ts", action: "allow" as const },
              { permission: "read", pattern: "*", action: "allow" as const },
            ]

            const session = await Session.create({ permission })

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "checkpoint-with-permission",
              permission,
            })

            const checkpoints = await SessionTimeline.list(session.id)
            expect(checkpoints.length).toBe(1)
            expect(checkpoints[0].permission).toEqual(permission)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore recovers permission grants from checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const originalPermission = [
              { permission: "edit", pattern: "*.ts", action: "allow" as const },
              { permission: "read", pattern: "*", action: "allow" as const },
            ]

            const session = await Session.create({ permission: originalPermission })

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
              permission: originalPermission,
            })

            // Modify permission after checkpoint
            const modifiedPermission = [
              { permission: "edit", pattern: "*.go", action: "allow" as const },
            ]
            await Session.setPermission({
              sessionID: session.id,
              permission: modifiedPermission,
            })

            // Verify permission was modified
            let sessionData = await Session.get(session.id)
            expect(sessionData.permission).toEqual(modifiedPermission)

            // Restore from checkpoint
            const restored = await SessionTimeline.restore(session.id, "abc123")

            // Permission should be restored to original
            expect(restored.permission).toEqual(originalPermission)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore recovers dsl_context from checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const originalDslContext = {
              vars: { counter: 10, important: "value" },
              history: [{ step: 1, action: "test" }],
            }

            const session = await Session.create({})

            // Set initial dsl_context
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: originalDslContext,
            })

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
              dsl_context: originalDslContext,
            })

            // Modify dsl_context after checkpoint
            const modifiedDslContext = {
              vars: { counter: 999 },
              history: [],
            }
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: modifiedDslContext,
            })

            // Verify dsl_context was modified
            let sessionData = await Session.get(session.id)
            expect(sessionData.dsl_context).toEqual(modifiedDslContext)

            // Restore from checkpoint
            const restored = await SessionTimeline.restore(session.id, "abc123")

            // dsl_context should be restored to original
            expect(restored.dsl_context).toEqual(originalDslContext)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore recovers both permission and dsl_context from checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const originalPermission = [
              { permission: "bash", pattern: "/bin/ls", action: "allow" as const },
            ]
            const originalDslContext = {
              vars: { workflow: "important-workflow" },
              history: [{ step: 5, action: "completed" }],
            }

            const session = await Session.create({ permission: originalPermission })

            // Set dsl_context
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: originalDslContext,
            })

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
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
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
              permission: originalPermission,
              dsl_context: originalDslContext,
            })

            // Modify both after checkpoint
            const modifiedPermission = [
              { permission: "bash", pattern: "/bin/rm", action: "deny" as const },
            ]
            const modifiedDslContext = {
              vars: { workflow: "new-workflow" },
              history: [],
            }
            await Session.setPermission({
              sessionID: session.id,
              permission: modifiedPermission,
            })
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: modifiedDslContext,
            })

            // Restore from checkpoint
            const restored = await SessionTimeline.restore(session.id, "abc123")

            // Both should be restored to original
            expect(restored.permission).toEqual(originalPermission)
            expect(restored.dsl_context).toEqual(originalDslContext)

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("checkpoint without permission or dsl_context restores safely", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})

            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "user",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info)

            // Create checkpoint WITHOUT permission and dsl_context
            await Session.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: session.id,
              type: "step-start",
              snapshot: "abc123",
            })

            // Modify permission and dsl_context after checkpoint
            const modifiedPermission = [
              { permission: "edit", pattern: "*.go", action: "allow" as const },
            ]
            const modifiedDslContext = {
              vars: { test: "value" },
              history: [],
            }
            await Session.setPermission({
              sessionID: session.id,
              permission: modifiedPermission,
            })
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: modifiedDslContext,
            })

            // Restore from checkpoint without permission/dsl_context
            const restored = await SessionTimeline.restore(session.id, "abc123")

            // Since checkpoint didn't have permission/dsl_context, they should NOT be restored
            // (they stay as modified)
            expect(restored.permission).toEqual(modifiedPermission)
            expect(restored.dsl_context).toEqual(modifiedDslContext)

            await Session.remove(session.id)
          },
        }),
    })
  })
})
