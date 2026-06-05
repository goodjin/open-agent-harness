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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-resource-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness resource fabric", () => {
  test("stores large model output as a resource ref for session display", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "store long output", ...cfg })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_writer", kind: "act", title: "Write report", status: "completed" },
        })
        const body = "Architecture note. ".repeat(400)
        const out = await HarnessRuntime.writeDocument(run.id, {
          kind: "model_long_output",
          title: "Architecture report",
          body,
          media_type: "text/markdown",
          producer: { type: "model", id: "agent.writer", run_id: run.id, action_id: "act_writer" },
          source_action: "act_writer",
          visibility: "project",
          evidence: ["action://act_writer"],
          threshold: 100,
          redact: [],
        })
        const list = await HarnessStore.resources(run.id)
        const full = await HarnessRuntime.readResource(run.id, out.resource.id)
        const events = await HarnessStore.events(run.id)

        expect(out.session.type).toBe("resource_ref")
        expect(out.session.ref).toBe(`resource://${out.resource.id}`)
        expect(out.session.summary).toContain("Architecture report")
        expect(JSON.stringify(out.session)).not.toContain(body)
        expect(list).toHaveLength(1)
        expect(list[0]?.kind).toBe("model_long_output")
        expect(list[0]?.source_action).toBe("act_writer")
        expect(list[0]?.visibility).toBe("project")
        expect(list[0]?.evidence).toEqual(["action://act_writer"])
        expect(full.body).toBe(body)
        expect(events.map((item) => item.type)).toContain("resource.written")
      },
    })
  })

  test("supports preview full read redacted export and tombstone", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "inspect resource", ...cfg })
        const body = `${"test report line. ".repeat(30)} contact me@example.com`
        const out = await HarnessRuntime.writeDocument(run.id, {
          kind: "test_report",
          title: "Test report",
          body,
          media_type: "text/plain",
          producer: { type: "tool", id: "bun.test", run_id: run.id },
          visibility: "team",
          evidence: ["trace://trace_report"],
          threshold: 20,
          redact: [],
        })

        const preview = await HarnessRuntime.previewResource(run.id, out.resource.id)
        const full = await HarnessRuntime.readResource(run.id, out.resource.id)
        const redacted = await HarnessRuntime.exportResource(run.id, out.resource.id, "redacted")
        const tomb = await HarnessRuntime.tombstoneResource(run.id, out.resource.id)
        const list = await HarnessStore.resources(run.id)

        expect(preview.preview.length).toBeLessThan(full.body.length)
        expect(preview.truncated).toBe(true)
        expect(redacted.body).toContain("[redacted-email]")
        expect(redacted.body).not.toContain("me@example.com")
        expect(tomb.lifecycle).toBe("tombstoned")
        expect(list[0]?.lifecycle).toBe("tombstoned")
        expect(list[0]?.visibility).toBe("team")
      },
    })
  })

  test("resource.write command records index and session ref", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "command resource", ...cfg })
        const out = await HarnessRuntime.command({
          type: "resource.write",
          run_id: run.id,
          actor: "runtime",
          payload: {
            kind: "tool_output",
            title: "Tool output",
            body: "tool output body".repeat(40),
            producer: { type: "tool", id: "bash", run_id: run.id },
            threshold: 10,
          },
        })

        expect(out.resource.kind).toBe("tool_output")
        expect(out.session.ref).toBe(`resource://${out.resource.id}`)
      },
    })
  })
})
