import { afterEach, describe, expect, test } from "bun:test"
import { AgentTemplateLoader } from "../../src/agent/loader"
import { Metrics } from "../../src/observability/metrics"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  Metrics.clear()
  await resetDatabase()
  await Instance.disposeAll()
})

describe("observability metrics", () => {
  test("agent load and permission evaluation emit stable names and labels", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Metrics.clear()
        await new AgentTemplateLoader().load()
        PermissionNext.evaluate("bash", "ls", [{ permission: "bash", pattern: "*", action: "allow" }])

        const samples = Metrics.list()
        expect(samples).toContainEqual(
          expect.objectContaining({
            name: "opencode_agent_load_total",
            labels: expect.objectContaining({ source: "all", status: "ok" }),
          }),
        )
        expect(samples).toContainEqual(
          expect.objectContaining({
            name: "opencode_agent_load_duration_ms",
            labels: expect.objectContaining({ source: "all" }),
          }),
        )
        expect(samples).toContainEqual(
          expect.objectContaining({
            name: "opencode_permission_evaluation_total",
            labels: expect.objectContaining({ permission: "bash", action: "allow" }),
          }),
        )
      },
    })
  })

  test("tool call and session metrics use the documented label keys", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Metrics.clear()
        Metrics.emit("opencode_tool_call_total", { tool: "read", status: "completed" })
        Metrics.emit("opencode_tool_call_duration_ms", { tool: "read", status: "completed" }, 2)
        Metrics.emit("opencode_session_lifecycle_total", { event: "status", status: "running" })

        const labels = Metrics.list().map((sample) => sample.labels)
        expect(labels).toContainEqual({ tool: "read", status: "completed" })
        expect(labels).toContainEqual({ event: "status", status: "running" })
      },
    })
  })

  test("keeps a bounded sample buffer and clear isolates tests", () => {
    Metrics.clear()
    for (const index of Array.from({ length: Metrics.CAPACITY + 5 }, (_, item) => item)) {
      Metrics.emit("opencode_tool_call_total", { tool: "read", status: "completed" }, index)
    }

    const samples = Metrics.list()
    expect(samples).toHaveLength(Metrics.CAPACITY)
    expect(samples[0].value).toBe(5)

    Metrics.clear()
    expect(Metrics.list()).toEqual([])
  })
})
