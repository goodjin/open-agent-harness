import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { HarnessRuntime, HarnessStore } from "../../src/harness"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness runtime", () => {
  test("creates a run and persists events", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({
          goal: "ship harness console",
          constraints: ["keep old UI intact"],
          memory_scopes: ["project"],
          automation: "guided",
        })
        const sum = await HarnessStore.summary(run.id)

        expect(sum?.run.goal).toBe("ship harness console")
        expect(sum?.tasks).toHaveLength(1)
        expect(sum?.events.map((item) => item.type)).toEqual(["run.created", "task.created"])
      },
    })
  })

  test("applies command gates for decisions and concepts", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({
          goal: "govern concepts",
          constraints: [],
          memory_scopes: ["project"],
          automation: "guided",
        })
        const next = await HarnessRuntime.command({
          type: "concept.replace.request",
          run_id: run.id,
          actor: "user",
          payload: {
            kind: "api",
            scope: "project",
            namespace: "orders",
            summary: "Order API v2",
            new_information: "The endpoint now returns settlement status.",
          },
        })
        const list = await HarnessStore.concepts()
        const graph = await HarnessRuntime.concepts()
        const audit = await HarnessRuntime.exportAudit(run.id, "markdown")
        const rebuild = await HarnessRuntime.rebuild(run.id)

        expect(next.id).toBe(run.id)
        expect(list).toHaveLength(1)
        expect(list[0]?.new_information).toBe("The endpoint now returns settlement status.")
        expect(graph.nodes).toHaveLength(1)
        expect(audit).toContain("# Harness Audit")
        expect(rebuild.source_events).toBeGreaterThan(0)
      },
    })
  })
})
