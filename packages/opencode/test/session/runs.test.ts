import { describe, expect, test } from "bun:test"
import { symlink } from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { AgentProtocol } from "../../src/protocol/schema"
import { Session } from "../../src/session"
import { SessionRuns } from "../../src/session/runs"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

describe("session runs", () => {
  test("lists protocol runs with task content and planning documents", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_runs"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_docs")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            const dir = path.join(tmp.path, ".harness", "sessions", session.id, "runs", run.run_id)
            await Bun.write(path.join(dir, "requirements", "backend.md"), "# Backend requirement\n")
            await Bun.write(path.join(dir, "manifest.md"), "# Manifest\n")

            const runs = await SessionRuns.list(session.id)
            expect(runs).toHaveLength(1)
            expect(runs[0]?.actions[0]?.input).toEqual({ prompt: "Implement backend" })
            expect(runs[0]?.documents.map((item) => item.path)).toEqual(["manifest.md", "requirements/backend.md"])
            expect((await SessionRuns.read(session.id, run.run_id, "requirements/backend.md"))?.body).toContain(
              "Backend requirement",
            )
          },
        }),
    })
  })

  test("includes the current running protocol projection", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_running_run"),
          fn: async () => {
            const session = await Session.create({})
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  current: "run_active",
                  runs: [
                    {
                      runID: "run_active",
                      title: "Active planning",
                      status: "running",
                      actions: [
                        {
                          id: "frontend",
                          title: "Frontend task",
                          operation: "frontend",
                          executor: { type: "agent", target: "frontend" },
                          input: { prompt: "Build Runs UI" },
                          depends_on: [],
                          status: "pending",
                          summary: "",
                          tool_call_ids: [],
                          duration_ms: 0,
                          time: { started: 10 },
                        },
                      ],
                      time: { started: 10 },
                      metrics: {
                        actions: 1,
                        internal_tool_calls: 0,
                        direct_model_tool_calls: 0,
                        model_visible_bytes: 0,
                        raw_output_bytes: 0,
                        duration_ms: 0,
                      },
                    },
                  ],
                },
              },
            })

            const runs = await SessionRuns.list(session.id)
            expect(runs[0]?.run_id).toBe("run_active")
            expect(runs[0]?.status).toBe("running")
            expect(runs[0]?.actions[0]?.input).toEqual({ prompt: "Build Runs UI" })
            expect((await SessionRuns.get(session.id, "run_active"))?.status).toBe("running")
          },
        }),
    })
  })

  test("rejects traversal, absolute paths, non-markdown files, and symlinks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_paths"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_paths")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            const dir = path.join(tmp.path, ".harness", "sessions", session.id, "runs", run.run_id, "plans")
            await Bun.write(path.join(dir, "task.md"), "safe")
            await Bun.write(path.join(dir, "task.txt"), "unsafe")
            await symlink(path.join(dir, "task.md"), path.join(dir, "link.md"))
            const outside = path.join(tmp.path, "outside")
            await Bun.write(path.join(outside, "leak.md"), "secret")
            await symlink(outside, path.join(path.dirname(dir), "reviews"))
            await Bun.write(path.join(path.dirname(dir), "requirements", "nested", "task.md"), "nested")
            await Bun.write(path.join(tmp.path, ".harness", "sessions", session.id, "plans", "escaped.md"), "escaped")

            expect(await SessionRuns.read(session.id, run.run_id, "../plans/task.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "/plans/task.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "plans/task.txt")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "plans/link.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "reviews/leak.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, "..", "plans/escaped.md")).toBeUndefined()
            expect((await SessionRuns.documents(session.id, run.run_id)).map((item) => item.path)).toEqual([
              "plans/task.md",
            ])
          },
        }),
    })
  })
})

function result(id: string) {
  const now = Date.now()
  return AgentProtocol.Result.parse({
    type: "agent.protocol.result",
    version: "1",
    run_id: id,
    status: "completed",
    title: "Planning run",
    actions: [
      {
        id: "backend",
        title: "Backend task",
        operation: "agent",
        executor: { type: "agent", target: "backend" },
        input: { prompt: "Implement backend" },
        depends_on: [],
        status: "completed",
        summary: "Done",
        tool_call_ids: [],
        duration_ms: 1,
        time: { started: now, completed: now + 1 },
      },
    ],
    summary: "Completed",
    time: { started: now, completed: now + 1 },
    metrics: {
      actions: 1,
      internal_tool_calls: 0,
      direct_model_tool_calls: 0,
      model_visible_bytes: 0,
      raw_output_bytes: 0,
      duration_ms: 1,
    },
  })
}
