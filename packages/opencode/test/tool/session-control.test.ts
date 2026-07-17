import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionControlTool } from "../../src/tool/session-control"
import { MessageID } from "../../src/session/schema"
import { SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(resetDatabase)

const ctx = (sessionID: string) =>
  ({
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.ascending(),
    agent: "default",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }) as Tool.Context

describe("tool.session_control", () => {
  test("rejects sessions outside the current task update scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_control_scope"),
          fn: async () => {
            const parent = await Session.create({})
            const peer = await Session.create({})
            SessionStatus.set(peer.id, { type: "running" })
            const tool = await SessionControlTool.init()
            await expect(tool.execute({ action: "stop", session_ids: [peer.id] }, ctx(parent.id))).rejects.toThrow(
              "session_control_scope_violation",
            )
            expect(SessionStatus.get(peer.id).type).toBe("running")
            SessionStatus.set(peer.id, { type: "idle" })
          },
        }),
    })
  })
})
