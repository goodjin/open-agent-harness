import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { HarnessRuntime, HarnessStore } from "../../src/harness"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const cfg = {
  constraints: [] as string[],
  memory_scopes: ["project"] as ("project")[],
  automation: "guided" as const,
}
const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-workflow-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness workflow asset", () => {
  test("saves a workflow profile from a run action graph", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "save workflow", ...cfg })
        await HarnessRuntime.command({ type: "action.accept", run_id: run.id, actor: "runtime", payload: { id: "act_a", kind: "act", title: "A", criteria: ["A done"] } })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_b", kind: "act", title: "B", depends_on: ["act_a"], criteria: ["B done"], visibility: "team" },
        })

        const out = await HarnessRuntime.saveWorkflowFromRun(run.id, { owner: "team", source: "run" })
        const list = await HarnessStore.workflows()

        expect(out.asset.version).toBe(1)
        expect(out.asset.profile.nodes.map((item) => item.id)).toEqual(["act_a", "act_b"])
        expect(out.asset.profile.nodes[1]?.depends_on).toEqual(["act_a"])
        expect(out.asset.profile.nodes[1]?.visibility).toBe("team")
        expect(list[0]?.id).toBe(out.asset.id)
      },
    })
  })

  test("runs a workflow profile as normal action graph with acceptance inheritance", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const asset = await HarnessRuntime.putWorkflow({
          owner: "team",
          source: "test",
          visibility: "project",
          profile: {
            goal: "ship workflow",
            inputs_schema: {},
            criteria: ["workflow passes"],
            nodes: [
              { id: "plan", title: "Plan", criteria: ["plan accepted"], depends_on: [] },
              { id: "verify", title: "Verify", criteria: ["tests pass"], depends_on: ["plan"], gate: "test" },
            ],
          },
        })
        const out = await HarnessRuntime.runWorkflow(asset.id, { inputs: { feature: "x" } })
        const acts = await HarnessStore.actions(out.run.id)
        const acc = await HarnessStore.acceptance(out.run.id)

        expect(out.run.goal).toBe("ship workflow")
        expect(acts.map((item) => item.id)).toEqual(["plan", "verify"])
        expect(acts.find((item) => item.id === "verify")?.depends_on).toEqual(["plan"])
        expect(acc.find((item) => item.target.ref === "action://verify")?.criteria).toEqual(["tests pass"])
      },
    })
  })

  test("recovers failed workflow nodes through retry skip repair and decision", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "recover workflow", ...cfg })
        await HarnessRuntime.command({ type: "action.accept", run_id: run.id, actor: "runtime", payload: { id: "node", kind: "act", title: "Node", status: "failed" } })

        expect((await HarnessRuntime.recoverWorkflowNode(run.id, "node", { op: "retry" })).action?.status).toBe("ready")
        expect((await HarnessRuntime.recoverWorkflowNode(run.id, "node", { op: "skip" })).action?.status).toBe("completed")
        expect((await HarnessRuntime.recoverWorkflowNode(run.id, "node", { op: "repair", reason: "fix tests" })).assignment?.role).toBe("repair")
        expect((await HarnessRuntime.recoverWorkflowNode(run.id, "node", { op: "decision", reason: "skip or retry" })).decision?.question).toContain("skip or retry")
      },
    })
  })
})
