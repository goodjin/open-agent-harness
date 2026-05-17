import { describe, expect, test } from "bun:test"
import path from "path"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionTimeline } from "../../src/session/timeline"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Snapshot } from "../../src/snapshot"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")

async function snap(dir: string) {
  await Bun.write(path.join(dir, "checkpoint.txt"), "checkpoint\n")
  const hash = await Snapshot.track()
  if (!hash) throw new Error("snapshot hash missing")
  return hash
}

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
  test("restore rejects a checkpoint hash from another session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            await Bun.write(path.join(tmp.path, "test.txt"), "original")
            const hash = await Snapshot.track()
            if (!hash) throw new Error("snapshot hash missing")
            const first = await Session.create({})
            const second = await Session.create({})
            const messageID = MessageID.ascending()
            await Session.updateMessage({
              id: messageID,
              sessionID: first.id,
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
              sessionID: first.id,
              type: "step-start",
              snapshot: hash,
            })

            await expect(SessionTimeline.restore(second.id, hash)).rejects.toThrow()

            await Session.remove(first.id)
            await Session.remove(second.id)
          },
        }),
    })
  })

  test("preview reports changed files without restoring", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const file = path.join(tmp.path, "preview.txt")
            await Bun.write(file, "before\n")
            const hash = await Snapshot.track()
            if (!hash) throw new Error("snapshot hash missing")
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
              snapshot: hash,
            })

            await Bun.write(file, "after\n")
            const preview = await SessionTimeline.preview(session.id, hash)

            expect(preview.checkpoint.hash).toBe(hash)
            expect(preview.files).toContain(file.replaceAll("\\", "/"))
            expect(preview.diff).toContain("after")
            expect(await Bun.file(file).text()).toBe("after\n")

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore publishes an audit event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            await Bun.write(path.join(tmp.path, "audit.txt"), "before\n")
            const hash = await Snapshot.track()
            if (!hash) throw new Error("snapshot hash missing")
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
              snapshot: hash,
            })
            const events: Array<{ sessionID: string; hash: string; type: "restore" }> = []
            const unsub = Bus.subscribe(SessionTimeline.Event.Audit, (event) => events.push(event.properties))

            await SessionTimeline.restore(session.id, hash)
            unsub()

            expect(events).toContainEqual({
              type: "restore",
              sessionID: session.id,
              hash,
            })

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore rejects invalid checkpoint trees without audit or file mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const file = path.join(tmp.path, "invalid.txt")
            await Bun.write(file, "before\n")
            const session = await Session.create({})
            const hash = "invalid-checkpoint-tree"
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
            await Bun.write(file, "after\n")
            const events: Array<{ sessionID: string; hash: string; type: "restore" }> = []
            const unsub = Bus.subscribe(SessionTimeline.Event.Audit, (event) => events.push(event.properties))

            await expect(SessionTimeline.restore(session.id, hash)).rejects.toThrow()
            unsub()

            expect(await Bun.file(file).text()).toBe("after\n")
            expect(events).toEqual([])

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restore reverts workspace files to checkpoint state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const file = path.join(tmp.path, "test.txt")
            await Bun.write(file, "original content")
            const hash = await Snapshot.track()
            if (!hash) throw new Error("snapshot hash missing")

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
              snapshot: hash,
            })

            await Bun.write(file, "modified content")
            expect(await Bun.file(file).text()).toBe("modified content")

            const restored = await SessionTimeline.restore(session.id, hash)
            expect(restored.id).toBe(session.id)
            expect(await Bun.file(file).text()).toBe("original content")

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
            const hash = await snap(tmp.path)
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
              snapshot: hash,
            })

            const restored1 = await SessionTimeline.restore(session.id, hash)
            const restored2 = await SessionTimeline.restore(session.id, hash)
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
            const hash = await snap(tmp.path)
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
              snapshot: hash,
            })

            await SessionTimeline.restore(session.id, hash)

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
            const hash = await snap(tmp.path)
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
              snapshot: hash,
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
            const sessionData = await Session.get(session.id)
            expect(sessionData.permission).toEqual(modifiedPermission)

            const restored = await SessionTimeline.restore(session.id, hash)

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
            const hash = await snap(tmp.path)
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
              snapshot: hash,
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
            const sessionData = await Session.get(session.id)
            expect(sessionData.dsl_context).toEqual(modifiedDslContext)

            const restored = await SessionTimeline.restore(session.id, hash)

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
            const hash = await snap(tmp.path)
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
              snapshot: hash,
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

            const restored = await SessionTimeline.restore(session.id, hash)

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
            const hash = await snap(tmp.path)
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
              snapshot: hash,
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

            const restored = await SessionTimeline.restore(session.id, hash)

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
