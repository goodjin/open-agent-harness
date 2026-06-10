import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLog } from "../../src/session/log"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRecovery } from "../../src/session/recovery"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("session recovery", () => {
  test("marks stale running tools and records recovery packet", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_stale"),
          fn: async () => {
            const data = await stale(tmp.path, "git push origin main")
            await SessionLog.emit({
              sessionID: data.sessionID,
              messageID: data.messageID,
              partID: data.partID,
              level: "info",
              type: "tool.start",
              data: { tool: "bash" },
              time: data.start,
            })
            await SessionLog.emit({
              sessionID: data.sessionID,
              level: "info",
              type: "permission.asked",
              data: { command: "git push origin main" },
              time: data.start + 1,
            })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(1)
            expect(packets[0].session_id).toBe(data.sessionID)
            expect(packets[0].tools[0].tool).toBe("bash")
            expect(packets[0].tools[0].risk).toBe("high")
            expect(packets[0].tools[0].recovery_hint).toBe("requires_user_confirmation")
            expect(packets[0].tools[0].logs).toContain("tool.start")
            expect(packets[0].tools[0].logs).toContain("permission.asked")

            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("error")
            if (part.state.status !== "error") return
            expect(part.state.error).toContain("interrupted")
            expect(part.state.metadata?.recovery?.status).toBe("stale_interrupted")
            expect(part.state.metadata?.recovery?.risk).toBe("high")

            const logs = await SessionLog.list({ sessionID: data.sessionID, limit: 100 })
            expect(logs.map((item) => item.type)).toContain("session.recovery.detected")
            expect(logs.map((item) => item.type)).toContain("session.recovery.tool_marked_stale")
          },
        }),
    })
  })

  test("does not mark tools for sessions active in current process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_active"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "running" })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(0)
            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("running")
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })

  test("marks tools for sessions interrupted by a previous process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_interrupted"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "interrupted", prior: "running" })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(1)
            expect(packets[0].session_id).toBe(data.sessionID)
            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("error")
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })
})

async function stale(dir: string, command: string) {
  const session = await Session.create({ title: "recovery-test" })
  const user = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)

  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    parentID: user,
    role: "assistant",
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    path: {
      cwd: dir,
      root: dir,
    },
    time: { created: Date.now() },
    sessionID: session.id,
  } as MessageV2.Assistant)

  const start = Date.now()
  const partID = PartID.ascending()
  await Session.updatePart({
    id: partID,
    sessionID: session.id,
    messageID,
    type: "tool",
    callID: "call_recovery",
    tool: "bash",
    state: {
      status: "running",
      input: { command },
      title: command,
      time: { start },
    },
  })

  return {
    sessionID: session.id as SessionID,
    messageID,
    partID,
    start,
  }
}
