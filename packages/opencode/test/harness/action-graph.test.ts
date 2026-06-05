import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { HarnessRuntime, HarnessStore } from "../../src/harness"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const dirs: string[] = []
const cfg = {
  constraints: [] as string[],
  memory_scopes: ["project"] as ("project")[],
  automation: "guided" as const,
}

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-action-graph-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness persistent action graph", () => {
  test("persists accepted act records with queryable M1 fields", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "build action graph", ...cfg })

        const next = await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: {
            id: "act_plan",
            kind: "act",
            title: "Plan implementation",
            type: "agent",
            status: "ready",
            criteria: ["plan saved"],
            failure: "request human clarification",
            gate: "auto",
            budget: { tokens: 2000, timeout_ms: 30000 },
            visibility: "project",
            expected_artifacts: ["document://plan_01"],
            idempotency_key: "plan-implementation",
            resource_locks: ["resource://repo"],
            cancellation: { allowed: true, reason: "user stop" },
            retry_policy: { max: 2, backoff: "linear" },
          },
        })

        const graph = await HarnessStore.actionGraph(run.id)
        const list = await HarnessStore.actions(run.id)
        const projection = await HarnessRuntime.actionGraph(run.id)
        const events = await HarnessStore.events(run.id)

        expect(next.id).toBe(run.id)
        expect(graph?.run_id).toBe(run.id)
        expect(list).toHaveLength(1)
        expect(list[0]?.id).toBe("act_plan")
        expect(list[0]?.criteria).toEqual(["plan saved"])
        expect(list[0]?.gate).toBe("auto")
        expect(list[0]?.budget.tokens).toBe(2000)
        expect(list[0]?.visibility).toBe("project")
        expect(list[0]?.expected_artifacts).toEqual(["document://plan_01"])
        expect(list[0]?.idempotency_key).toBe("plan-implementation")
        expect(list[0]?.resource_locks).toEqual(["resource://repo"])
        expect(list[0]?.cancellation.allowed).toBe(true)
        expect(list[0]?.retry_policy.max).toBe(2)
        expect(projection.nodes.map((item) => item.id)).toContain("act_plan")
        expect(events.map((item) => item.type)).toContain("action.accepted")
      },
    })
  })

  test("rebuilds projection from persisted actions and dependency edges", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "recover graph", ...cfg })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_a", kind: "act", title: "A", status: "completed" },
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_b", kind: "act", title: "B", depends_on: ["act_a"] },
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_c", kind: "act", title: "C", depends_on: ["act_missing"] },
        })

        const projection = await HarnessRuntime.rebuildActionGraph(run.id)

        expect(projection.edges.map((item) => `${item.from}->${item.to}`)).toEqual(["act_a->act_b", "act_missing->act_c"])
        expect(projection.ready).toContain("act_b")
        expect(projection.blocked).toContainEqual({ id: "act_c", reason: "waiting for dependencies" })
        expect(projection.source_events).toBeGreaterThanOrEqual(5)
      },
    })
  })

  test("updates action state for cancellation and retry commands", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "state graph", ...cfg })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_state", kind: "act", title: "State", status: "running" },
        })

        await HarnessRuntime.command({ type: "action.cancel", run_id: run.id, task_id: "act_state", actor: "runtime", payload: {} })
        expect((await HarnessStore.action(run.id, "act_state"))?.status).toBe("cancelled")

        await HarnessRuntime.command({ type: "action.retry", run_id: run.id, task_id: "act_state", actor: "runtime", payload: {} })
        expect((await HarnessStore.action(run.id, "act_state"))?.status).toBe("ready")
      },
    })
  })
})
