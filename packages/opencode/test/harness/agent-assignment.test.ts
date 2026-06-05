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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-agent-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness agent assignment", () => {
  test("validates v2 agent template metadata", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const agent = await HarnessRuntime.putAgentTemplate({
          id: "agent_planner",
          identity: "Planner",
          kind: "planner",
          entry: { primary: true, delegable: true, mentionable: true },
          capability: { tags: ["planning"], writes: false, cost: "low" },
          permission: { tools: ["read"], scopes: ["project"], write: false },
          model_preference: { provider: "openai", model: "gpt-5" },
          execution_mode: "protocol",
          relationships: { supervises: ["agent_worker"], peers: [] },
          orchestration_policy: { max_parallel: 2, review_required: true },
          availability: "available",
        })
        const list = await HarnessStore.agentTemplates()

        expect(agent.kind).toBe("planner")
        expect(agent.entry.delegable).toBe(true)
        expect(agent.permission.write).toBe(false)
        expect(list).toHaveLength(1)
      },
    })
  })

  test("filters routing candidates by entry capability permission and budget", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        await HarnessRuntime.putAgentTemplate({
          id: "agent_worker",
          identity: "Worker",
          kind: "worker",
          entry: { primary: false, delegable: true, mentionable: true },
          capability: { tags: ["implementation"], writes: true, cost: "medium" },
          permission: { tools: ["bash", "edit"], scopes: ["project"], write: true },
          execution_mode: "chat",
          relationships: { supervises: [], peers: ["agent_verifier"] },
          orchestration_policy: { max_parallel: 1, review_required: false },
          availability: "available",
        })
        await HarnessRuntime.putAgentTemplate({
          id: "agent_hidden",
          identity: "Hidden",
          kind: "helper",
          entry: { primary: false, delegable: false, mentionable: false },
          capability: { tags: ["implementation"], writes: true, cost: "high" },
          permission: { tools: ["edit"], scopes: ["private"], write: true },
          execution_mode: "chat",
          relationships: { supervises: [], peers: [] },
          orchestration_policy: { max_parallel: 1, review_required: false },
          availability: "busy",
        })

        const route = await HarnessRuntime.routeAgents({
          entry: "delegable",
          capability: ["implementation"],
          permission: { write: true, scopes: ["project"] },
          budget: { max_cost: "medium" },
          projection: { run_id: "run_01", ready: ["act_01"] },
        })

        expect(route.candidates.map((item) => item.id)).toEqual(["agent_worker"])
        expect(route.excluded).toContainEqual({ id: "agent_hidden", reason: "entry unavailable" })
      },
    })
  })

  test("creates assignment and agent session for agent action", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "assign agent", ...cfg })
        await HarnessRuntime.putAgentTemplate({
          id: "agent_worker",
          identity: "Worker",
          kind: "worker",
          entry: { primary: false, delegable: true, mentionable: true },
          capability: { tags: ["implementation"], writes: true, cost: "medium" },
          permission: { tools: ["bash"], scopes: ["project"], write: true },
          execution_mode: "protocol",
          relationships: { supervises: [], peers: [] },
          orchestration_policy: { max_parallel: 1, review_required: false },
          availability: "available",
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_build", kind: "act", type: "agent", title: "Build feature", status: "ready" },
        })

        const out = await HarnessRuntime.assignAgent(run.id, {
          action_id: "act_build",
          template_id: "agent_worker",
          role: "worker",
          authority: { write: true },
          context_summary: "Use resource://res_plan and current projection.",
          trace_refs: ["trace://trace_assign"],
        })
        const assignments = await HarnessStore.assignments(run.id)
        const sessions = await HarnessStore.agentSessions(run.id)
        const events = await HarnessStore.events(run.id)

        expect(out.assignment.task_id).toBe("act_build")
        expect(out.session.template_id).toBe("agent_worker")
        expect(out.session.assignment_id).toBe(out.assignment.id)
        expect(out.session.context_summary).toContain("resource://res_plan")
        expect(assignments).toHaveLength(1)
        expect(sessions).toHaveLength(1)
        expect(events.map((item) => item.type)).toContain("agent.assigned")
      },
    })
  })
})
