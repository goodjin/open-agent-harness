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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-handoff-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness handoff protocol", () => {
  test("persists assign records with refs instead of transcript body", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "handoff work", ...cfg })
        const note = await HarnessRuntime.writeDocument(run.id, {
          kind: "handoff_state",
          title: "Assignment state",
          body: "raw transcript line ".repeat(80),
          summary: "assignment state summary",
          producer: { type: "agent", id: "planner", run_id: run.id },
          visibility: "project",
        })
        const out = await HarnessRuntime.writeHandoff(run.id, {
          kind: "assign",
          source: { type: "agent", id: "planner" },
          target: { type: "agent", id: "worker" },
          summary: "Worker should implement the next action",
          state: "ready",
          evidence: ["action://act_plan"],
          risks: ["schema may change"],
          unresolved: ["confirm verifier"],
          next: ["compile context", "start worker"],
          resource_refs: [note.resource.uri],
          projection_ref: "projection://action-graph",
          trace_ref: "trace://assign-trace",
        })
        const list = await HarnessStore.handoffs(run.id)
        const events = await HarnessStore.events(run.id)

        expect(out.uri).toBe(`handoff://${out.id}`)
        expect(out.kind).toBe("assign")
        expect(out.source.id).toBe("planner")
        expect(out.target.id).toBe("worker")
        expect(out.resource_refs).toEqual([note.resource.uri])
        expect(JSON.stringify(out)).not.toContain("raw transcript line")
        expect(list).toHaveLength(1)
        expect(events.map((item) => item.type)).toContain("handoff.assign")
      },
    })
  })

  test("normalizes sync into canonical handoff records", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "sync work", ...cfg })
        const sync = HarnessRuntime.normalizeSync({
          source: { type: "agent", id: "worker" },
          target: { type: "agent", id: "planner" },
          summary: "Tests are running",
          evidence: ["trace://test-start"],
          risks: ["long test duration"],
          unresolved: ["await result"],
          next: ["send final handoff"],
          resource_refs: ["resource://test-report", "resource://test-report"],
          trace_ref: "trace://sync-trace",
        })
        const out = await HarnessRuntime.writeHandoff(run.id, sync)

        expect(out.kind).toBe("sync")
        expect(out.state).toBe("ready")
        expect(out.resource_refs).toEqual(["resource://test-report"])
        expect(out.refs).toContain("trace://sync-trace")
        expect(out.evidence).toEqual(["trace://test-start"])
      },
    })
  })

  test("builds downstream context from handoff and resource refs", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "compile handoff context", ...cfg })
        const report = await HarnessRuntime.writeDocument(run.id, {
          kind: "review_report",
          title: "Review report",
          body: "review body with evidence",
          summary: "review summary",
          producer: { type: "agent", id: "verifier", run_id: run.id },
          visibility: "project",
        })
        const hand = await HarnessRuntime.writeHandoff(run.id, {
          kind: "handoff",
          source: { type: "agent", id: "worker" },
          target: { type: "agent", id: "verifier" },
          summary: "Verify the implementation",
          state: "ready",
          resource_refs: [report.resource.uri],
          projection_ref: "projection://action-graph",
          trace_ref: "trace://worker-trace",
          context_ref: "snapshot://worker-context",
          next: ["run verification"],
        })

        const out = await HarnessRuntime.handoffContext(run.id, hand.id, {
          goal: "verify implementation",
          token_budget: 200,
          visibility: "project",
        })

        expect(out.refs.handoff_ref).toBe(hand.uri)
        expect(out.refs.resource_refs).toEqual([report.resource.uri])
        expect(out.bundle.refs).toContain(hand.uri)
        expect(out.bundle.refs).toContain(report.resource.uri)
        expect(out.bundle.refs).toContain("projection://action-graph")
        expect(out.bundle.refs).toContain("trace://worker-trace")
        expect(out.bundle.summary).toContain("review summary")
      },
    })
  })
})
