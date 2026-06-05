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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-memory-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness memory mechanism", () => {
  test("generates candidates from resource refs and gates promotion", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "remember result", ...cfg })
        const res = await HarnessRuntime.writeDocument(run.id, {
          kind: "research_note",
          title: "Research",
          body: "Use bun package-level tests for harness changes.",
          summary: "Use package-level Bun tests",
          producer: { type: "agent", id: "researcher", run_id: run.id },
        })
        const mem = await HarnessRuntime.createMemoryCandidate(run.id, {
          summary: "Harness tests run from packages/opencode",
          scope: "project",
          namespace: "testing",
          source_refs: [res.resource.uri],
          evidence_refs: [res.resource.uri],
          visibility: "project",
          freshness: "current",
        })

        expect(mem.status).toBe("candidate")
        expect(HarnessRuntime.promoteMemory(run.id, mem.id, { acceptance_id: "missing" })).rejects.toThrow("approved acceptance")

        const acc = await HarnessRuntime.bindAcceptance(run.id, {
          target: { type: "resource", ref: mem.uri },
          criteria: ["memory is accurate"],
          policy: HarnessRuntime.acceptancePolicy({ criteria: ["memory is accurate"], artifact_type: "memory" }),
          required: true,
        })
        await HarnessRuntime.recordAcceptance(run.id, acc.id, { result: "approved", evidence: [res.resource.uri], reviewer: "owner" })
        const out = await HarnessRuntime.promoteMemory(run.id, mem.id, { acceptance_id: acc.id })

        expect(out.status).toBe("current")
        expect((await HarnessStore.memoryRecords()).find((item) => item.id === mem.id)?.status).toBe("current")
      },
    })
  })

  test("uses memory refs in context and lets current projection override history", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "compile memory", ...cfg })
        const mem = await HarnessRuntime.createMemoryCandidate(run.id, {
          summary: "Old branch is main",
          scope: "project",
          namespace: "branch",
          source_refs: ["trace://old"],
          evidence_refs: ["trace://old"],
          visibility: "project",
          freshness: "historical",
        })
        await HarnessStore.projection(run.id, "memory-current", { namespace: "branch", summary: "Current branch is dev" })

        const out = await HarnessRuntime.memoryContext(run.id, {
          goal: "choose branch",
          namespace: "branch",
          memory_refs: [mem.uri],
          token_budget: 200,
          visibility: "project",
        })

        expect(out.bundle.excluded.find((item) => item.ref === mem.uri)?.reason).toContain("projection overrides")
        expect(out.bundle.summary).toContain("Current branch is dev")
      },
    })
  })
})
