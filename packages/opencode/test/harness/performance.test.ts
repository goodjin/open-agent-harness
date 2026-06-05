import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Harness, HarnessStore, HarnessRuntime } from "../../src/harness"
import { tmpdir } from "../fixture/fixture"

describe("Harness performance profile", () => {
  test("reports capacity pressure for large runs", async () => {
    await using temp = await tmpdir({ git: true })

    await Instance.provide({
      directory: temp.path,
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "Performance regression fixture", constraints: [], memory_scopes: ["project"], automation: "guided" })

        for (let i = 0; i < 560; i += 1) {
          await HarnessStore.append(
            Harness.Event.parse({
              id: `evt_${String(i).padStart(3, "0")}`,
              run_id: run.id,
              time: Date.now() + i,
              type: "harness.performance.event",
              payload: { index: i },
            }),
          )
        }

        for (let i = 0; i < 120; i += 1) {
          await HarnessStore.putTask(
            Harness.Task.parse({
              id: `task_${String(i).padStart(3, "0")}`,
              run_id: run.id,
              title: `task ${i}`,
              goal: `goal ${i}`,
              gates: [{ id: `gate_${i}`, status: "passed" }],
              artifacts: [`art_${i}`],
              created_at: Date.now() + i,
              updated_at: Date.now() + i,
            }),
          )
        }

        for (let i = 0; i < 70; i += 1) {
          await HarnessStore.putArtifact(
            Harness.Artifact.parse({
              id: `artifact_${String(i).padStart(3, "0")}`,
              run_id: run.id,
              kind: "report",
              path: `/tmp/perf-${i}.md`,
              summary: `artifact ${i}`,
              created_at: Date.now() + i,
            }),
          )
        }

        for (let i = 0; i < 15; i += 1) {
          await HarnessStore.putAssignment(
            run.id,
            Harness.Assignment.parse({
              id: `assign_${String(i).padStart(3, "0")}`,
              task_id: `task_${String(i).padStart(3, "0")}`,
              actor: "agent",
              role: "worker",
              updated_at: Date.now() + i,
              capabilities: ["read", "write"],
            }),
          )
        }

        const result = await HarnessRuntime.performance(run.id)

        expect(result.run_id).toBe(run.id)
        expect(result.counts.events).toBe(562)
        expect(result.counts.tasks).toBe(121)
        expect(result.counts.artifacts).toBe(70)
        expect(result.counts.assignments).toBe(15)
        expect(result.counts.acceptance).toBe(121)
        expect(result.pressure).toContain("events")
        expect(result.status).toBe("blocked")
      },
    })
  })

  test("supports paged event query and run performance endpoint", async () => {
    await using temp = await tmpdir({ git: true })

    await Instance.provide({
      directory: temp.path,
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "Endpoint paging fixture", constraints: [], memory_scopes: ["project"], automation: "guided" })
        for (let i = 0; i < 140; i += 1) {
          await HarnessStore.append(
            Harness.Event.parse({
              id: `evt_${String(i).padStart(3, "0")}`,
              run_id: run.id,
              time: i,
              type: "harness.performance.event",
            }),
          )
        }

        const page = await HarnessRuntime.eventQuery({ run: run.id, limit: 25 })
        expect(page.items).toHaveLength(25)
        expect(page.cursor).toBe("25")

        const app = Server.Default()
        const res = await app.request(`/harness/runs/${run.id}/performance`, { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.run_id).toBe(run.id)
        expect(body.counts.events).toBe(142)

        const metrics = await app.request("/harness/performance", { method: "GET" })
        expect(metrics.status).toBe(200)
        const stats = await metrics.json()
        expect(stats.scheduler.active).toBe(0)
        expect(stats.scheduler.registered).toBe(0)
      },
    })
  })
})
