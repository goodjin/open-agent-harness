import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import path from "path"
import os from "os"

import { HarnessRuntime } from "../../src/harness"
import { HarnessStore } from "../../src/harness/store"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-governance-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness governance routes", () => {
  test("reads resources, sessions, handoffs and acceptance for run", async () => {
    const dir = await temp()
    const app = Server.Default()
    const scope = new URLSearchParams({ directory: dir }).toString()

    const result = await Instance.provide({
      directory: dir,
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "run governance", constraints: [], memory_scopes: ["project"], automation: "guided" })
        await HarnessRuntime.writeDocument(run.id, {
          kind: "tool_output",
          title: "Tool output",
          body: "tool output body".repeat(20),
          producer: { type: "tool", id: "bash", run_id: run.id },
          threshold: 20,
          visibility: "project",
        })
        await HarnessRuntime.putAgentTemplate({
          id: "tpl-agent",
          identity: "agent-one",
          kind: "worker",
          entry: { primary: true, delegable: true, mentionable: false },
          capability: { tags: ["docs", "tool"], writes: true, cost: "low" },
          permission: { tools: [], scopes: ["project"], write: true },
          relationships: { supervises: [], peers: [] },
          orchestration_policy: { max_parallel: 1, review_required: false },
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: {
            kind: "act",
            type: "agent",
            title: "Agent Step",
            status: "ready",
            id: "act-agent",
          },
        })

        const action = (await HarnessStore.actions(run.id)).find((item) => item.id === "act-agent")
        if (!action) throw new Error("action not found")

        await HarnessRuntime.assignAgent(run.id, {
          action_id: action.id,
          template_id: "tpl-agent",
          role: "agent",
          authority: {},
          context_summary: "task context",
          trace_refs: [],
        })

        const workflow = await HarnessRuntime.putWorkflow({
          owner: "planner",
          source: "goal-source",
          visibility: "project",
          profile: {
            goal: "run workflow",
            inputs_schema: {},
            nodes: [],
          },
          version: 1,
        })

        await HarnessRuntime.saveWorkflowFromRun(run.id, { owner: workflow.owner, source: workflow.source })

        const acc = await HarnessRuntime.bindAcceptance(run.id, {
          target: { type: "action", ref: `action://${action.id}` },
          criteria: ["run finished"],
          policy: HarnessRuntime.acceptancePolicy({ criteria: ["run finished"], artifact_type: "harness" }),
          required: true,
        })
        await HarnessRuntime.recordAcceptance(run.id, acc.id, {
          result: "approved",
          evidence: ["trace://run"],
          reviewer: "runtime",
        })

        const handoff = await HarnessRuntime.writeHandoff(run.id, {
          kind: "assign",
          source: { type: "runtime", id: "runtime" },
          target: { type: "agent", id: "agent-1" },
          summary: "handoff to agent",
          state: "ready",
          evidence: [],
        })

        return { run, handoff: handoff.id }
      },
    })

    const runRes = await app.request(`/harness/runs/${result.run.id}/resources?${scope}`)
    const sesRes = await app.request(`/harness/runs/${result.run.id}/agent-sessions?${scope}`)
    const handRes = await app.request(`/harness/runs/${result.run.id}/handoffs?${scope}`)
    const accRes = await app.request(`/harness/runs/${result.run.id}/acceptance?${scope}`)
    const tplRes = await app.request(`/harness/agent-templates?${scope}`)
    const wfRes = await app.request(`/harness/workflows?${scope}`)

    expect(runRes.status).toBe(200)
    expect(sesRes.status).toBe(200)
    expect(handRes.status).toBe(200)
    expect(accRes.status).toBe(200)
    expect(tplRes.status).toBe(200)
    expect(wfRes.status).toBe(200)

    const resources = (await runRes.json()) as Array<{ id: string }>
    const sessions = (await sesRes.json()) as Array<{ run_id: string }>
    const handoffs = (await handRes.json()) as Array<{ run_id: string; id: string }>
    const accepts = (await accRes.json()) as Array<{ target: { type: string } }>
    const templates = (await tplRes.json()) as Array<{ id: string; identity: string }>
    const workflows = (await wfRes.json()) as Array<{ id: string; owner: string }>

    expect(resources).toHaveLength(1)
    expect(sessions[0]?.run_id).toBe(result.run.id)
    expect(handoffs[0]?.run_id).toBe(result.run.id)
    expect(accepts[0]?.target.type).toBe("action")
    expect(templates.map((item) => item.id)).toContain("tpl-agent")
    expect(workflows[0]?.owner).toBe("planner")
    expect(handoffs[0]?.id).toBe(result.handoff)
  })

  test("generated OpenAPI includes governance endpoints", async () => {
    const spec = (await Bun.file(new URL("../../../../packages/sdk/openapi.json", import.meta.url)).json()) as {
      paths?: Record<string, { get?: { operationId?: string } }>
    }
    const p = spec.paths ?? {}

    expect(p["/harness/runs/{runID}/resources"]?.get?.operationId).toBe("harness.run.resources")
    expect(p["/harness/runs/{runID}/agent-sessions"]?.get?.operationId).toBe("harness.run.agent-sessions")
    expect(p["/harness/runs/{runID}/handoffs"]?.get?.operationId).toBe("harness.run.handoffs")
    expect(p["/harness/runs/{runID}/acceptance"]?.get?.operationId).toBe("harness.run.acceptance")
    expect(p["/harness/agent-templates"]?.get?.operationId).toBe("harness.agent.templates")
    expect(p["/harness/workflows"]?.get?.operationId).toBe("harness.workflows")
  })
})
