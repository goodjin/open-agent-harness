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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-acceptance-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness acceptance gates", () => {
  test("generates automatic test agent human combined and sampled policies", () => {
    expect(HarnessRuntime.acceptancePolicy({ criteria: ["schema valid"], risk: "low", artifact_type: "schema" }).level).toBe("auto")
    expect(HarnessRuntime.acceptancePolicy({ criteria: ["tests pass"], artifact_type: "code" }).level).toBe("test")
    expect(HarnessRuntime.acceptancePolicy({ criteria: ["review handoff"], artifact_type: "handoff", agent_kind: "verifier" }).level).toBe("agent")
    expect(HarnessRuntime.acceptancePolicy({ criteria: ["approve deploy"], risk: "high", side_effects: ["external_service"] }).level).toBe("human")
    expect(HarnessRuntime.acceptancePolicy({ criteria: ["ship feature"], risk: "high", artifact_type: "code", permission: "write" }).level).toBe("combined")
    expect(HarnessRuntime.acceptancePolicy({ criteria: ["spot check"], sample_rate: 0.2 }).level).toBe("sampled")
  })

  test("records gate results with projection and repair assignment", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "accept work", ...cfg })
        const rec = await HarnessRuntime.bindAcceptance(run.id, {
          target: { type: "assignment", ref: "action://act_review" },
          criteria: ["review report exists"],
          policy: HarnessRuntime.acceptancePolicy({ criteria: ["review report exists"], artifact_type: "handoff" }),
          required: true,
        })
        const out = await HarnessRuntime.recordAcceptance(run.id, rec.id, {
          result: "changes_requested",
          evidence: ["resource://review-report"],
          reason: "missing tests",
          reviewer: "agent.verifier",
        })
        const list = await HarnessStore.acceptance(run.id)
        const assignments = await HarnessStore.assignments(run.id)
        const projections = await HarnessStore.projections(run.id)

        expect(out.result).toBe("changes_requested")
        expect(out.evidence).toEqual(["resource://review-report"])
        expect(list[0]?.result).toBe("changes_requested")
        expect(assignments.find((item) => item.role === "repair")?.context).toContain("missing tests")
        expect(projections.find((item) => item.name === "acceptance-state")?.data).toEqual(list)
      },
    })
  })

  test("blocks completed actions until required gates are approved or waived", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "gate completion", ...cfg })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_impl", kind: "act", title: "Implement", criteria: ["tests pass"] },
        })

        expect(
          HarnessRuntime.command({
            type: "action.accept",
            run_id: run.id,
            actor: "runtime",
            payload: { id: "act_impl", kind: "act", title: "Implement", status: "completed", criteria: ["tests pass"] },
          }),
        ).rejects.toThrow("Acceptance gate required")

        const rec = await HarnessRuntime.bindAcceptance(run.id, {
          target: { type: "action", ref: "action://act_impl" },
          criteria: ["tests pass"],
          policy: HarnessRuntime.acceptancePolicy({ criteria: ["tests pass"], artifact_type: "code" }),
          required: true,
        })
        await HarnessRuntime.recordAcceptance(run.id, rec.id, {
          result: "approved",
          evidence: ["resource://test-report"],
          reviewer: "runtime",
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_impl", kind: "act", title: "Implement", status: "completed", criteria: ["tests pass"] },
        })

        expect((await HarnessStore.action(run.id, "act_impl"))?.status).toBe("completed")
      },
    })
  })
})
