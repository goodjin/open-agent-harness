import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { SessionID } from "../../src/session/schema"
import { SessionTask } from "../../src/session/task"
import { TaskInspectTool } from "../../src/tool/task-inspect"
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

describe("tool.task_inspect", () => {
  test("returns unbound without loading task history", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_task_inspect_unbound"),
          fn: async () => {
            const session = await Session.create({})
            const tool = await TaskInspectTool.init()
            const result = await tool.execute({ include: "summary" }, ctx(session.id))
            expect(JSON.parse(result.output)).toEqual({ status: "unbound" })
            expect(result.metadata).toMatchObject({ truncated: false })
          },
        }),
    })
  })

  test("keeps summary compact and expands workflow only when requested", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_task_inspect_bound"),
          fn: async () => {
            const session = await Session.create({})
            const saved = await SessionTask.route({
              sessionID: session.id,
              runID: "run_inspect",
              legacy: { title: "Inspect task", body: "Private full body" },
              actions: [{ id: "inspect_action", title: "Inspect action" }],
            })
            if (saved.type !== "execute") throw new Error("task missing")
            const tool = await TaskInspectTool.init()
            const summary = JSON.parse((await tool.execute({ include: "summary" }, ctx(session.id))).output)
            const workflow = JSON.parse((await tool.execute({ include: "workflow" }, ctx(session.id))).output)
            expect(summary).not.toHaveProperty("body")
            expect(summary).not.toHaveProperty("workflow")
            expect(workflow.body).toBe("Private full body")
            expect(workflow.workflow.actions).toHaveLength(1)
          },
        }),
    })
  })
})
