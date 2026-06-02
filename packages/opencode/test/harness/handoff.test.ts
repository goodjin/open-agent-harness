import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { HarnessRuntime, HarnessStore } from "../../src/harness"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-handoff-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness handoff", () => {
  test("creates a canonical handoff and downgrades claims without refs", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({
          goal: "fix toolbar undo state",
          constraints: [],
          memory_scopes: ["project"],
          automation: "guided",
        })
        const out = await HarnessRuntime.createHandoff({
          source: {
            run_id: run.id,
            session_id: "session_dev_01",
            assignment_id: "assign_fix_toolbar",
            agent_id: "code_developer",
          },
          target: {
            executor: "agent",
            capability: "code_review",
          },
          status: "completed",
          goal: "Review the toolbar undo state fix.",
          summary: "Undo state was fixed and focused tests passed.",
          facts: [
            { text: "Undo state refreshes after editor transactions.", refs: ["artifact://patch/undo_state"] },
            { text: "The change is low risk.", refs: [] },
          ],
          artifacts: [
            {
              ref: "artifact://patch/undo_state",
              type: "patch",
              summary: "Patch for undo state refresh.",
            },
          ],
          risks: ["Full package suite was not run."],
          unresolved: ["Run broader package tests."],
          next: ["Review changed editor state files."],
          raw_refs: ["artifact://raw/session/session_dev_01/full"],
        })
        const list = await HarnessStore.handoffs(run.id)
        const events = await HarnessStore.events(run.id)

        expect(out.facts).toHaveLength(1)
        expect(out.notes).toEqual(["The change is low risk."])
        expect(out.facts[0]?.confidence).toBe("evidenced")
        expect(list.map((item) => item.id)).toEqual([out.id])
        expect(events.some((item) => item.type === "handoff.created" && item.payload.handoff_id === out.id)).toBe(true)
      },
    })
  })

  test("rejects handoff creation for unknown runs", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        await expect(
          HarnessRuntime.createHandoff({
            source: { run_id: "run_missing", agent_id: "code_developer" },
            status: "completed",
            goal: "Review patch.",
            summary: "Patch is ready for review.",
          }),
        ).rejects.toThrow("Run not found: run_missing")
      },
    })
  })

  test("renders markdown for the target context bundle", () => {
    const text = HarnessRuntime.renderHandoff({
      type: "handoff",
      version: "1",
      id: "handoff_fix_toolbar_to_review",
      source: {
        run_id: "run_123",
        session_id: "session_dev_01",
        assignment_id: "assign_fix_toolbar",
        agent_id: "code_developer",
      },
      target: {
        executor: "agent",
        capability: "code_review",
      },
      status: "completed",
      goal: "Review the toolbar undo state fix.",
      summary: "Undo state was fixed and focused tests passed.",
      facts: [
        {
          text: "Undo state refreshes after editor transactions.",
          refs: ["artifact://patch/undo_state"],
          confidence: "evidenced",
        },
      ],
      notes: ["The change is low risk."],
      artifacts: [
        {
          ref: "artifact://patch/undo_state",
          type: "patch",
          status: "available",
          summary: "Patch for undo state refresh.",
        },
      ],
      decisions: [],
      constraints: [],
      risks: ["Full package suite was not run."],
      unresolved: ["Run broader package tests."],
      next: [{ goal: "Review changed editor state files.", depends_on: ["artifact://patch/undo_state"] }],
      raw_refs: ["artifact://raw/session/session_dev_01/full"],
      visibility: {
        model: "summary",
        user: "summary",
        logs: "full",
        trace: "summary",
        future_runs: "ref",
      },
      created_by: "runtime",
      created_at: 1,
    })

    expect(text).toContain("## Handoff")
    expect(text).toContain("Source: `code_developer`")
    expect(text).toContain("Ref: `artifact://patch/undo_state`")
    expect(text).toContain("### Raw Evidence")
    expect(text).not.toContain('"type": "handoff"')
  })

  test("builds a source bundle from events and artifacts", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({
          goal: "review toolbar patch",
          constraints: [],
          memory_scopes: ["project"],
          automation: "guided",
        })
        await HarnessStore.putArtifact({
          id: "patch_undo_state",
          run_id: run.id,
          kind: "patch",
          path: "artifact://patch/undo_state",
          summary: "Patch for undo state refresh.",
          created_at: 1,
        })
        await HarnessStore.append({
          id: "event_tool_result",
          run_id: run.id,
          type: "tool.result",
          actor: "runtime",
          time: 2,
          summary: "Focused undo state tests passed.",
          payload: {
            artifacts: ["artifact://test/toolbar_passed"],
            raw_refs: ["artifact://raw/tool/test_stdout"],
          },
        })

        const out = await HarnessRuntime.buildHandoffSource({
          run_id: run.id,
          source: {
            run_id: run.id,
            session_id: "session_dev_01",
            agent_id: "code_developer",
          },
          status: "completed",
          self_report: {
            summary: "Undo state was fixed.",
            risks: ["Full package suite was not run."],
          },
        })

        expect(out.type).toBe("handoff.source")
        expect(out.goal).toBe("review toolbar patch")
        expect(out.timeline.some((item) => item.type === "tool.result" && item.refs.includes("artifact://test/toolbar_passed"))).toBe(true)
        expect(out.artifacts.map((item) => item.ref)).toContain("artifact://patch/undo_state")
        expect(out.raw_refs).toContain("artifact://raw/tool/test_stdout")
        expect(out.self_report?.risks).toEqual(["Full package suite was not run."])
      },
    })
  })

  test("plans a runtime-triggered handoff and asks for self-report", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({
          goal: "review toolbar patch",
          constraints: [],
          memory_scopes: ["project"],
          automation: "guided",
        })
        await HarnessStore.putAssignment(run.id, {
          id: "assign_fix_toolbar",
          task_id: "task_fix_toolbar",
          actor: "code_developer",
          role: "developer",
          status: "completed",
          capabilities: ["code"],
          authority: {},
          updated_at: 1,
        })

        const out = await HarnessRuntime.planHandoff({
          run_id: run.id,
          source: {
            run_id: run.id,
            assignment_id: "assign_fix_toolbar",
            agent_id: "code_developer",
          },
          next: ["Review changed toolbar files."],
        })

        expect(out.trigger).toBe(true)
        expect(out.reasons).toEqual(["assignment_terminal", "downstream_next"])
        expect(out.request_self_report).toBe(true)
        expect(out.status).toBe("completed")
        expect(out.prompt).toContain("Done:")
        expect(out.prompt).not.toContain("JSON")
      },
    })
  })

  test("records a runtime self-report request through command", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({
          goal: "review toolbar patch",
          constraints: [],
          memory_scopes: ["project"],
          automation: "guided",
        })
        const out = (await HarnessRuntime.command({
          type: "handoff.self_report.request",
          run_id: run.id,
          actor: "runtime",
          payload: {
            source: {
              run_id: run.id,
              session_id: "session_dev_01",
              agent_id: "code_developer",
            },
            status: "partial",
            reasons: ["context_budget"],
          },
        })) as { type: string; id: string; prompt: string }
        const events = await HarnessStore.events(run.id)

        expect(out.type).toBe("handoff.self_report_request")
        expect(out.prompt).toContain("Risks:")
        expect(events.some((item) => item.type === "handoff.self_report_requested" && item.payload.request_id === out.id)).toBe(true)
      },
    })
  })

  test("lists handoffs through the harness route", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const app = Server.Default()
        const run = await HarnessRuntime.create({
          goal: "review toolbar patch",
          constraints: [],
          memory_scopes: ["project"],
          automation: "guided",
        })
        const item = await HarnessRuntime.createHandoff({
          source: { run_id: run.id, agent_id: "code_developer" },
          status: "completed",
          goal: "Review patch.",
          summary: "Patch is ready for review.",
          facts: [{ text: "Patch exists.", refs: ["artifact://patch/current"] }],
        })
        const res = await app.request(`/harness/runs/${run.id}/handoffs`)
        const body = (await res.json()) as { id: string; summary: string }[]

        expect(res.status).toBe(200)
        expect(body.map((entry) => ({ id: entry.id, summary: entry.summary }))).toEqual([
          { id: item.id, summary: "Patch is ready for review." },
        ])
      },
    })
  })
})
