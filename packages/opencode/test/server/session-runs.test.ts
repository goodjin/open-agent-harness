import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { AgentProtocol } from "../../src/protocol/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionRuns } from "../../src/session/runs"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

describe("session run endpoints", () => {
  test("lists protocol runs and reads their markdown documents", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_routes"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_route")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "Completed",
              messageID: "msg_run_route",
            })
            await Bun.write(
              path.join(tmp.path, ".harness", "sessions", session.id, "runs", run.run_id, "plans", "app.md"),
              "# App plan\n",
            )
            const app = Server.Default()
            const dir = `directory=${encodeURIComponent(tmp.path)}`

            const listed = await app.request(`/session/${session.id}/runs?${dir}`)
            expect(listed.status).toBe(200)
            const runs = (await listed.json()) as Array<{
              kind: string
              run_id: string
              task: string
              summary?: string
              summary_source?: string
              execution_summary?: string
              action_id?: string
              fallback: boolean
              status: string
              actions: unknown[]
              documents: Array<{ path: string }>
              metrics: { actions: number }
            }>
            expect(runs[0]?.run_id).toBe(run.run_id)
            expect(runs[0]).toMatchObject({
              kind: "protocol",
              task: "Planning run",
              summary: "Completed",
              summary_source: "protocol",
              execution_summary: "Completed",
              fallback: false,
              status: "completed",
              actions: [],
              metrics: { actions: 0 },
            })
            expect(runs[0]?.documents[0]?.path).toBe("plans/app.md")

            const doc = await app.request(
              `/session/${session.id}/runs/${run.run_id}/document?path=plans%2Fapp.md&${dir}`,
            )
            expect(doc.status).toBe(200)
            expect(((await doc.json()) as { body: string }).body).toBe("# App plan\n")

            const denied = await app.request(
              `/session/${session.id}/runs/${run.run_id}/document?path=..%2Fsecret.md&${dir}`,
            )
            expect(denied.status).toBe(404)

            await Bun.write(
              path.join(tmp.path, ".harness", "sessions", session.id, "runs", "run_orphan", "plans", "app.md"),
              "orphan",
            )
            const orphan = await app.request(
              `/session/${session.id}/runs/run_orphan/document?path=plans%2Fapp.md&${dir}`,
            )
            expect(orphan.status).toBe(404)

            const invalid = await app.request(`/session/${session.id}/runs/run.?${dir}`)
            expect(invalid.status).toBe(400)

            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  current: "run_active",
                  runs: [
                    {
                      runID: "run_active",
                      status: "running",
                      actions: [],
                      time: { started: Date.now() },
                      metrics: {
                        actions: 0,
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
            const active = await app.request(`/session/${session.id}/runs/run_active?${dir}`)
            expect(active.status).toBe(200)
            expect(((await active.json()) as { status: string }).status).toBe("running")
          },
        }),
    })
  })

  test("generated OpenAPI includes session run endpoints", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()
    const paths = spec.paths as Record<string, { get?: { operationId?: string } }>
    const schema = spec.paths["/session/{sessionID}/runs"].get.responses["200"].content["application/json"].schema
      .items as { properties: Record<string, unknown>; required: string[] }

    expect(paths["/session/{sessionID}/runs"]?.get?.operationId).toBe("session.runs")
    expect(paths["/session/{sessionID}/runs/{runID}"]?.get?.operationId).toBe("session.run")
    expect(paths["/session/{sessionID}/runs/{runID}/documents"]?.get?.operationId).toBe("session.run.documents")
    expect(paths["/session/{sessionID}/runs/{runID}/document"]?.get?.operationId).toBe("session.run.document")
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "kind",
        "task",
        "summary",
        "summary_source",
        "execution_summary",
        "action_id",
        "fallback",
        "status",
        "actions",
        "documents",
        "metrics",
      ]),
    )
    expect(schema.required).toEqual(
      expect.arrayContaining(["kind", "task", "fallback", "status", "actions", "metrics"]),
    )
    expect(schema.required).not.toEqual(expect.arrayContaining(["summary", "summary_source", "execution_summary", "action_id"]))
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
    actions: [],
    summary: "Completed",
    time: { started: now, completed: now + 1 },
    metrics: {
      actions: 0,
      internal_tool_calls: 0,
      direct_model_tool_calls: 0,
      model_visible_bytes: 0,
      raw_output_bytes: 0,
      duration_ms: 1,
    },
  })
}
