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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-context-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness context compiler", () => {
  test("compiles resource refs with token budget downgrades and excluded records", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "compile context", ...cfg })
        const small = await HarnessRuntime.writeDocument(run.id, {
          kind: "research_note",
          title: "Short note",
          body: "small implementation note",
          summary: "short summary",
          producer: { type: "model", id: "agent.writer", run_id: run.id },
          visibility: "project",
        })
        const large = await HarnessRuntime.writeDocument(run.id, {
          kind: "model_long_output",
          title: "Long note",
          body: "large implementation detail ".repeat(120),
          summary: "large summary",
          producer: { type: "model", id: "agent.writer", run_id: run.id },
          visibility: "project",
        })

        const out = await HarnessRuntime.compileContext({
          run_id: run.id,
          goal: "prepare implementation",
          user_input: "use the short note first",
          refs: [small.resource.uri, large.resource.uri],
          expansion: {
            [small.resource.uri]: "full",
            [large.resource.uri]: "adaptive",
          },
          token_budget: 30,
          visibility: "project",
        })
        const list = await HarnessStore.contextBundles(run.id)

        expect(out.included.map((item) => item.ref)).toContain(small.resource.uri)
        expect(out.included.find((item) => item.ref === small.resource.uri)?.mode).toBe("full")
        expect(out.included.find((item) => item.ref === large.resource.uri)?.mode).toBe("summary")
        expect(out.included.find((item) => item.ref === large.resource.uri)?.reason).toContain("downgraded")
        expect(out.tokens_used).toBeLessThanOrEqual(out.token_budget)
        expect(out.summary).toContain("short summary")
        expect(out.refs).toEqual([small.resource.uri, large.resource.uri])
        expect(list).toHaveLength(1)
      },
    })
  })

  test("excludes private refs from project context and previews the reason", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "respect visibility", ...cfg })
        const secret = await HarnessRuntime.writeDocument(run.id, {
          kind: "tool_output",
          title: "Private output",
          body: "private command output",
          summary: "private summary",
          producer: { type: "tool", id: "shell", run_id: run.id },
          visibility: "private",
        })

        const out = await HarnessRuntime.previewContext({
          run_id: run.id,
          goal: "show context",
          refs: [secret.resource.uri],
          expansion: { [secret.resource.uri]: "full" },
          token_budget: 100,
          visibility: "project",
        })

        expect(out.bundle.included).toHaveLength(0)
        expect(out.bundle.excluded[0]?.ref).toBe(secret.resource.uri)
        expect(out.bundle.excluded[0]?.reason).toContain("visibility")
        expect(out.explanations[0]?.decision).toBe("excluded")
        expect(out.explanations[0]?.reason).toContain("private")
      },
    })
  })

  test("supports summary structured full deferred and adaptive expansion modes", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "expand refs", ...cfg })
        const doc = await HarnessRuntime.writeDocument(run.id, {
          kind: "test_report",
          title: "Test report",
          body: "full body from tests",
          summary: "test summary",
          producer: { type: "tool", id: "bun.test", run_id: run.id },
          visibility: "project",
          evidence: ["trace://test-run"],
        })
        const refs = [doc.resource.uri, "handoff://next-agent", "memory://project-note", "projection://run-state"]

        const out = await HarnessRuntime.compileContext({
          run_id: run.id,
          goal: "choose expansion",
          refs,
          expansion: {
            [doc.resource.uri]: "structured",
            "handoff://next-agent": "on_demand",
            "memory://project-note": "on_failure",
            "projection://run-state": "summary",
          },
          token_budget: 200,
          visibility: "project",
        })

        const item = out.included.find((next) => next.ref === doc.resource.uri)
        expect(item?.mode).toBe("structured")
        expect(item?.content).toContain("test_report")
        expect(item?.content).toContain("trace://test-run")
        expect(out.excluded.find((next) => next.ref === "handoff://next-agent")?.reason).toContain("on demand")
        expect(out.excluded.find((next) => next.ref === "memory://project-note")?.reason).toContain("on failure")
        expect(out.included.find((next) => next.ref === "projection://run-state")?.content).toContain("projection://run-state")
      },
    })
  })
})
