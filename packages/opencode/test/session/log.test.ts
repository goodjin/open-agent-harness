import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLog } from "../../src/session/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

describe("session log", () => {
  test("stores payload manifests as session-local semantic chunks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_payload_chunks"),
          fn: async () => {
            const session = await Session.create({})
            const first = SessionLog.payloadID()
            const second = SessionLog.payloadID()

            await SessionLog.savePayloadManifest({
              id: first,
              sessionID: session.id,
              kind: "llm.request",
              meta: { modelID: "gpt-test" },
              sections: [
                {
                  id: "system",
                  label: "System Prompt",
                  chunks: [
                    {
                      kind: "system_prompt",
                      format: "markdown",
                      title: "System",
                      data: "shared system",
                    },
                  ],
                },
              ],
            })
            await SessionLog.savePayloadManifest({
              id: second,
              sessionID: session.id,
              kind: "llm.request",
              meta: { modelID: "gpt-test" },
              sections: [
                {
                  id: "system",
                  label: "System Prompt",
                  chunks: [
                    {
                      kind: "system_prompt",
                      format: "markdown",
                      title: "System",
                      data: "shared system",
                    },
                  ],
                },
              ],
            })
            const a = await SessionLog.readPayload({ id: first, sessionID: session.id })
            const b = await SessionLog.readPayload({ id: second, sessionID: session.id })

            expect(a?.data).toMatchObject({
              version: 2,
              kind: "llm.request",
              sections: [
                {
                  id: "system",
                  chunks: [
                    {
                      kind: "system_prompt",
                      format: "markdown",
                      data: "shared system",
                    },
                  ],
                },
              ],
            })
            expect(
              (
                (a?.data as { sections: { chunks: { id: string }[] }[] }).sections[0]?.chunks[0]?.id
              ),
            ).toBe(((b?.data as { sections: { chunks: { id: string }[] }[] }).sections[0]?.chunks[0]?.id))
          },
        }),
    })
  })

  test("stores timeline records and prunes records older than seven days", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_log"),
          fn: async () => {
            const session = await Session.create({})
            const now = Date.UTC(2026, 4, 18, 12)

            await SessionLog.emit({
              sessionID: session.id,
              time: now - 1_000,
              level: "info",
              type: "tool.start",
              data: { tool: "bash" },
            })
            await SessionLog.emit({
              sessionID: session.id,
              time: now,
              level: "debug",
              type: "llm.start",
              data: { providerID: "openai", modelID: "gpt-test" },
            })
            await SessionLog.emit({
              sessionID: session.id,
              time: now - SessionLog.retention - 1,
              level: "info",
              type: "old",
              data: {},
            })

            expect((await SessionLog.list({ sessionID: session.id })).map((item) => item.type)).toEqual([
              "old",
              "tool.start",
              "llm.start",
            ])

            await SessionLog.cleanup(now)

            const list = await SessionLog.list({ sessionID: session.id })
            expect(list.map((item) => item.type)).toEqual(["tool.start", "llm.start"])
            expect(list[0].data).toEqual({ tool: "bash" })
            expect((await SessionLog.list({ sessionID: session.id, cursor: list[0].id, limit: 1 })).map((item) => item.type)).toEqual([
              "llm.start",
            ])
          },
        }),
    })
  })

  test("exports protocol traces with comparison metrics", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_protocol_log"),
          fn: async () => {
            const session = await Session.create({})

            await SessionLog.emit({
              sessionID: session.id,
              level: "info",
              type: "protocol.started",
              data: { runID: "apr_1", title: "Inspect" },
            })
            await SessionLog.emit({
              sessionID: session.id,
              level: "info",
              type: "protocol.action.tool_call",
              data: { runID: "apr_1", actionID: "inspect", callID: "call_1", tool: "grep", outputBytes: 200 },
            })
            await SessionLog.emit({
              sessionID: session.id,
              level: "info",
              type: "protocol.completed",
              data: {
                runID: "apr_1",
                result: { type: "agent.protocol.result", status: "completed" },
                metrics: { modelVisibleBytes: 50 },
              },
            })

            const trace = await SessionLog.protocolTrace({ sessionID: session.id, runID: "apr_1" })

            expect(trace?.type).toBe("agent.protocol.trace")
            expect(trace?.metrics.internal_tool_calls).toBe(1)
            expect(trace?.metrics.raw_output_bytes).toBe(200)
            expect(trace?.metrics.model_visible_bytes).toBe(50)
          },
        }),
    })
  })
})
