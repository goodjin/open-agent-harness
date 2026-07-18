import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionTask } from "../../src/session/task"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionControlTool } from "../../src/tool/session-control"
import { MessageID } from "../../src/session/schema"
import { SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { AgentProtocol } from "../../src/protocol/schema"
import { Database, eq } from "../../src/storage/db"
import { SessionTaskTable } from "../../src/session/session.sql"

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
  test("rejects stop_all before a task revision enters recovery", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () => WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_control_state_gate"),
          fn: async () => {
            for (const status of ["running", "waiting_user"] as const) {
              const parent = await Session.create({})
              const child = await Session.create({ parentID: parent.id, agent: "backend" })
              const action = {
                type: "action",
                id: `child_${status}`,
                title: `Child ${status}`,
                operation: "delegate",
                executor: { type: "agent", target: "backend", capabilities: [] },
                input: {},
                depends_on: [],
                context_refs: [],
                result_policy: "summary",
              } as AgentProtocol.Action
              await SessionTask.route({
                sessionID: parent.id,
                runID: `run_${status}`,
                legacy: { title: "Task", body: "Task" },
                actions: [action],
              })
              await SessionAssignment.delegate({
                action,
                childID: child.id,
                messageID: MessageID.ascending(),
                runID: `run_${status}`,
                sessionID: parent.id,
              })
              if (status === "waiting_user")
                Database.use((db) => db.update(SessionTaskTable).set({ status }).where(eq(SessionTaskTable.session_id, parent.id)).run())
              SessionStatus.set(child.id, { type: "running" })

              const tool = await SessionControlTool.init()
              await expect(tool.execute({ action: "stop_all" }, ctx(parent.id))).rejects.toThrow(
                "session_control_revision_required",
              )
              expect(SessionStatus.get(child.id).type).toBe("running")
            }
          },
        }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

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
