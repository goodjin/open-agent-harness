import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionTimeline } from "../../src/session/timeline"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { WorkflowState } from "../../src/workflow/state"
import { tmpdir } from "../fixture/fixture"

async function workflow(dir: string, data: unknown) {
  const root = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(root, { recursive: true })
  const parsed = data as { id?: string }
  await Bun.write(path.join(root, `${parsed.id ?? "test"}.json`), JSON.stringify(data))
}

describe("workflow executor", () => {
  test("runs a two-step sequential workflow", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "seq",
      name: "Sequential",
      steps: [{ id: "one", outputs: { one: "done" } }, { id: "two", outputs: { two: "$one" } }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "seq" })

            expect(state.status).toBe("completed")
            expect(state.steps.map((step) => step.id)).toEqual(["one", "two"])
            expect(state.current).toBe("two")
            expect(state.variables.two).toBe("done")
            expect(state.attempts).toEqual({ one: 1, two: 1 })
            expect(WorkflowState.read((await Session.get(session.id)).dsl_context)?.status).toBe("completed")
          },
        }),
    })
  })

  test("runs nodes DAG dependencies in order", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "dag-serial",
      name: "Dag Serial",
      nodes: [
        { id: "one", outputs: { one: "done" } },
        { id: "two", depends_on: ["one"], outputs: { two: "$one" } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "dag-serial" })

            expect(state.status).toBe("completed")
            expect(state.steps.map((step) => step.id)).toEqual(["one", "two"])
            expect(state.statuses).toEqual({ one: "completed", two: "completed" })
            expect(state.completed).toEqual(["one", "two"])
            expect(state.variables.two).toBe("done")
          },
        }),
    })
  })

  test("runs parallel ready DAG nodes in the same batch", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "dag-parallel",
      name: "Dag Parallel",
      nodes: [
        { id: "left", prompt: "Left" },
        { id: "right", prompt: "Right" },
        { id: "join", depends_on: ["left", "right"], outputs: { done: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const started: string[] = []
            let release = () => {}
            const wait = new Promise<void>((resolve) => {
              release = resolve
            })
            const state = await WorkflowExecutor.run({
              sessionID: session.id,
              workflowID: "dag-parallel",
              agent: "workflow-runner",
              execute: async (input) => {
                started.push(input.step.id)
                if (started.length === 2) release()
                await wait
                return {
                  agent: input.agent,
                  sessionID: session.id,
                  output: input.step.id,
                }
              },
            })

            expect(state.status).toBe("completed")
            expect(started.slice(0, 2).sort()).toEqual(["left", "right"])
            expect(state.completed).toContain("join")
            expect(state.statuses).toMatchObject({
              left: "completed",
              right: "completed",
              join: "completed",
            })
          },
        }),
    })
  })

  test("dispatches prompted steps and persists node result", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "dispatch",
      name: "Dispatch",
      steps: [
        {
          id: "inspect",
          agent: "primary",
          prompt: "Inspect the target files",
          outputs: { inspected: "$inspect" },
        },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({
              sessionID: session.id,
              workflowID: "dispatch",
              agent: "workflow-runner",
              execute: async (input) => ({
                agent: input.agent,
                sessionID: session.id,
                output: `ran ${input.step.id}`,
              }),
            })

            expect(state.status).toBe("completed")
            expect(state.variables.inspect).toBe("ran inspect")
            expect(state.variables.inspected).toBe("ran inspect")
            expect(state.nodes.inspect?.status).toBe("completed")
            expect(state.nodes.inspect?.agent).not.toBe("workflow-runner")
            expect(state.nodes.inspect?.sessionID).toBe(session.id)

            const file = path.join(tmp.path, ".opencode", "workflows", "runs", state.runID, "inspect.json")
            const node = JSON.parse(await Bun.file(file).text()) as { status: string; output: string }
            expect(node.status).toBe("completed")
            expect(node.output).toBe("ran inspect")
          },
        }),
    })
  })

  test("rejects workflow runner for ordinary execution nodes", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "bad-agent",
      name: "Bad Agent",
      nodes: [{ id: "review", type: "review", agent: "workflow-runner", prompt: "Review code." }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "bad-agent" })

            expect(state.status).toBe("error")
            expect(state.error).toContain("cannot use workflow runner")
          },
        }),
    })
  })

  test("persists failed prompted step before applying error policy", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "dispatch-fail",
      name: "Dispatch Fail",
      steps: [{ id: "inspect", prompt: "Inspect the target files" }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({
              sessionID: session.id,
              workflowID: "dispatch-fail",
              agent: "workflow-runner",
              execute: async () => {
                throw new Error("node failed")
              },
            })

            expect(state.status).toBe("error")
            expect(state.attempts.inspect).toBe(1)
            expect(state.nodes.inspect?.status).toBe("error")
            expect(state.nodes.inspect?.error).toBe("node failed")

            const file = path.join(tmp.path, ".opencode", "workflows", "runs", state.runID, "inspect.json")
            const node = JSON.parse(await Bun.file(file).text()) as { status: string; error: string }
            expect(node.status).toBe("error")
            expect(node.error).toBe("node failed")
          },
        }),
    })
  })

  test("runs missing verification steps before completing", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "verify",
      name: "Verify",
      steps: [
        {
          id: "build",
          type: "implementation",
          outputs: { built: true },
          next: "ship",
          verification: {
            required: true,
            must_pass: ["test"],
          },
        },
        {
          id: "test",
          type: "test",
          outputs: { tested: true },
        },
        {
          id: "ship",
          type: "release",
          outputs: { shipped: "$tested" },
        },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "verify" })

            expect(state.status).toBe("completed")
            expect(state.current).toBe("test")
            expect(state.variables.built).toBe(true)
            expect(state.variables.shipped).toBeUndefined()
            expect(state.variables.tested).toBe(true)
            expect(state.completed).toEqual(["build", "ship", "test"])
          },
        }),
    })
  })

  test("legacy next skips intermediate steps", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "jump",
      name: "Jump",
      steps: [
        { id: "start", next: "ship", outputs: { start: true } },
        { id: "test", outputs: { test: true } },
        { id: "ship", outputs: { ship: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "jump" })

            expect(state.status).toBe("completed")
            expect(state.completed).toEqual(["start", "ship"])
            expect(state.variables.start).toBe(true)
            expect(state.variables.test).toBeUndefined()
            expect(state.variables.ship).toBe(true)
            expect(state.statuses.test).toBe("skipped")
          },
        }),
    })
  })

  test("legacy branch miss still runs completed step verification", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "branch-verify",
      name: "Branch Verify",
      steps: [
        {
          id: "start",
          next: [{ step: "next", guards: [{ type: "variable", name: "flag", equals: true }] }],
          outputs: { start: true },
          verification: {
            required: true,
            must_pass: ["test"],
          },
        },
        { id: "next", outputs: { next: true } },
        { id: "test", type: "test", outputs: { test: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "branch-verify" })

            expect(state.status).toBe("completed")
            expect(state.completed).toEqual(["start", "test"])
            expect(state.statuses.next).toBe("skipped")
            expect(state.variables.start).toBe(true)
            expect(state.variables.next).toBeUndefined()
            expect(state.variables.test).toBe(true)
          },
        }),
    })
  })

  test("denies unsafe permission transitions", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "guard",
      name: "Guard",
      steps: [
        {
          id: "unsafe",
          guards: [{ type: "permission", permission: "workflow.transition", pattern: "unsafe" }],
        },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({
              permission: [{ permission: "workflow.transition", pattern: "unsafe", action: "deny" }],
            })
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "guard" })

            expect(state.status).toBe("error")
            expect(state.error).toContain("permission denied")
          },
        }),
    })
  })

  test("checkpoints before mutating steps and restore returns prior workflow state", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "mutate",
      name: "Mutate",
      steps: [{ id: "edit", mutates: true, outputs: { edited: true } }, { id: "done" }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "mutate" })
            const checkpoints = await SessionTimeline.list(session.id)

            expect(state.status).toBe("completed")
            expect(checkpoints).toHaveLength(1)
            expect(checkpoints[0].dsl_context?.workflow).toBeDefined()

            await SessionTimeline.restore(session.id, checkpoints[0].hash)
            const restored = WorkflowState.read((await Session.get(session.id)).dsl_context)
            expect(restored?.status).toBe("active")
            expect(restored?.current).toBe("edit")
            expect(restored?.variables.edited).toBeUndefined()
          },
        }),
    })
  })

  test("pauses and resumes waiting_user and waiting_permission workflows", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "pause",
      name: "Pause",
      steps: [
        { id: "ask", wait: "user", outputs: { seen: "$answer" } },
        { id: "approve", wait: "permission", outputs: { approved: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const paused = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "pause" })
            expect(paused.status).toBe("waiting_user")
            expect(SessionStatus.get(session.id).type).toBe("waiting_user")

            const waiting = await WorkflowExecutor.resume({
              sessionID: session.id,
              variables: { answer: "yes" },
            })
            expect(waiting.status).toBe("waiting_permission")
            expect(SessionStatus.get(session.id).type).toBe("waiting_permission")

            const done = await WorkflowExecutor.resume({ sessionID: session.id, approved: true })
            expect(done.status).toBe("completed")
            expect(done.variables.seen).toBe("yes")
            expect(done.variables.approved).toBe(true)
          },
        }),
    })
  })

  test("requires explicit permission approval before resuming", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "approve",
      name: "Approve",
      steps: [{ id: "gate", wait: "permission", outputs: { ran: true } }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const missing = await Session.create({})
            const paused = await WorkflowExecutor.run({ sessionID: missing.id, workflowID: "approve" })
            expect(paused.status).toBe("waiting_permission")

            await expect(WorkflowExecutor.resume({ sessionID: missing.id })).rejects.toThrow("WorkflowInvalidError")
            expect(WorkflowState.read((await Session.get(missing.id)).dsl_context)?.status).toBe("waiting_permission")
            expect(WorkflowState.read((await Session.get(missing.id)).dsl_context)?.attempts.gate).toBeUndefined()

            const rejected = await Session.create({})
            await WorkflowExecutor.run({ sessionID: rejected.id, workflowID: "approve" })
            const denied = await WorkflowExecutor.resume({ sessionID: rejected.id, approved: false })
            expect(denied.status).toBe("error")
            expect(denied.attempts.gate).toBeUndefined()
            expect(denied.variables.ran).toBeUndefined()

            const accepted = await Session.create({})
            await WorkflowExecutor.run({ sessionID: accepted.id, workflowID: "approve" })
            const done = await WorkflowExecutor.resume({ sessionID: accepted.id, approved: true })
            expect(done.status).toBe("completed")
            expect(done.variables.ran).toBe(true)
          },
        }),
    })
  })

  test("approved permission resume only releases the waiting step guard", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "guards",
      name: "Guards",
      steps: [
        {
          id: "gate",
          guards: [
            { type: "permission", permission: "workflow.a", pattern: "a" },
            { type: "permission", permission: "workflow.b", pattern: "b" },
          ],
          outputs: { ran: true },
        },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const asked = await Session.create({})
            const pause = await WorkflowExecutor.run({ sessionID: asked.id, workflowID: "guards" })
            expect(pause.status).toBe("waiting_permission")
            expect(pause.pause?.reason).toContain("workflow.a a")

            const still = await WorkflowExecutor.resume({ sessionID: asked.id, approved: true })
            expect(still.status).toBe("waiting_permission")
            expect(still.pause?.reason).toContain("workflow.b b")
            expect(still.attempts.gate).toBeUndefined()
            expect(still.variables.ran).toBeUndefined()

            const denied = await Session.create({
              permission: [{ permission: "workflow.b", pattern: "b", action: "deny" }],
            })
            await WorkflowExecutor.run({ sessionID: denied.id, workflowID: "guards" })
            const error = await WorkflowExecutor.resume({ sessionID: denied.id, approved: true })
            expect(error.status).toBe("error")
            expect(error.error).toContain("workflow.b b")
            expect(error.attempts.gate).toBeUndefined()
            expect(error.variables.ran).toBeUndefined()
          },
        }),
    })
  })

  test("uses branch permission guards without falling back to sequential steps", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "branch",
      name: "Branch",
      steps: [
        {
          id: "start",
          next: [{ step: "blocked", guards: [{ type: "permission", permission: "workflow.branch", pattern: "blocked" }] }],
        },
        { id: "blocked", outputs: { hit: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const denied = await Session.create({
              permission: [{ permission: "workflow.branch", pattern: "blocked", action: "deny" }],
            })
            const error = await WorkflowExecutor.run({ sessionID: denied.id, workflowID: "branch" })
            expect(error.status).toBe("error")
            expect(error.variables.hit).toBeUndefined()

            const asked = await Session.create({})
            const paused = await WorkflowExecutor.run({ sessionID: asked.id, workflowID: "branch" })
            expect(paused.status).toBe("waiting_permission")
            expect(paused.variables.hit).toBeUndefined()

            const allowed = await Session.create({
              permission: [{ permission: "workflow.branch", pattern: "blocked", action: "allow" }],
            })
            const done = await WorkflowExecutor.run({ sessionID: allowed.id, workflowID: "branch" })
            expect(done.status).toBe("completed")
            expect(done.variables.hit).toBe(true)
          },
        }),
    })
  })

  test("approved permission resume only releases the waiting branch guard", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "branch-guards",
      name: "Branch Guards",
      steps: [
        {
          id: "start",
          next: [
            {
              step: "blocked",
              guards: [
                { type: "permission", permission: "workflow.a", pattern: "a" },
                { type: "permission", permission: "workflow.b", pattern: "b" },
              ],
            },
          ],
        },
        { id: "blocked", outputs: { hit: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const asked = await Session.create({})
            const pause = await WorkflowExecutor.run({ sessionID: asked.id, workflowID: "branch-guards" })
            expect(pause.status).toBe("waiting_permission")
            expect(pause.pause?.reason).toContain("workflow.a a")

            const still = await WorkflowExecutor.resume({ sessionID: asked.id, approved: true })
            expect(still.status).toBe("waiting_permission")
            expect(still.pause?.reason).toContain("workflow.b b")
            expect(still.variables.hit).toBeUndefined()

            const denied = await Session.create({
              permission: [{ permission: "workflow.b", pattern: "b", action: "deny" }],
            })
            await WorkflowExecutor.run({ sessionID: denied.id, workflowID: "branch-guards" })
            const error = await WorkflowExecutor.resume({ sessionID: denied.id, approved: true })
            expect(error.status).toBe("error")
            expect(error.error).toContain("workflow.b b")
            expect(error.variables.hit).toBeUndefined()
          },
        }),
    })
  })

  test("does not fall back to sequential step when explicit branches do not match", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "nomatch",
      name: "No Match",
      steps: [
        {
          id: "start",
          next: [{ step: "next", guards: [{ type: "variable", name: "flag", equals: true }] }],
        },
        { id: "next", outputs: { hit: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "nomatch" })

            expect(state.status).toBe("completed")
            expect(state.current).toBe("start")
            expect(state.variables.hit).toBeUndefined()
          },
        }),
    })
  })

  test("validates required workflow inputs, types, and defaults", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "inputs",
      name: "Inputs",
      inputs: {
        name: { type: "string", required: true },
        count: { type: "number", default: 2 },
        ok: { type: "boolean" },
        meta: { type: "object" },
      },
      steps: [{ id: "done" }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const missing = await Session.create({})
            await expect(WorkflowExecutor.run({ sessionID: missing.id, workflowID: "inputs" })).rejects.toThrow(
              "WorkflowInvalidError",
            )

            const wrong = await Session.create({})
            await expect(
              WorkflowExecutor.run({ sessionID: wrong.id, workflowID: "inputs", variables: { name: "Ada", ok: "yes" } }),
            ).rejects.toThrow("WorkflowInvalidError")

            const valid = await Session.create({})
            const state = await WorkflowExecutor.run({
              sessionID: valid.id,
              workflowID: "inputs",
              variables: { name: "Ada", ok: true, meta: { role: "math" } },
            })
            expect(state.status).toBe("completed")
            expect(state.variables.count).toBe(2)
          },
        }),
    })
  })

  test("applies retry, continue, and abort error policies", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "retry",
      name: "Retry",
      error_policy: { strategy: "retry", max_attempts: 3 },
      steps: [{ id: "fail", guards: [{ type: "variable", name: "ready", exists: true }] }],
    })
    await workflow(tmp.path, {
      id: "continue",
      name: "Continue",
      steps: [
        {
          id: "fail",
          error_policy: { strategy: "continue", max_attempts: 1 },
          guards: [{ type: "variable", name: "ready", exists: true }],
        },
        { id: "done", outputs: { done: true } },
      ],
    })
    await workflow(tmp.path, {
      id: "abort",
      name: "Abort",
      error_policy: { strategy: "abort", max_attempts: 1 },
      steps: [{ id: "fail", guards: [{ type: "variable", name: "ready", exists: true }] }],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const retried = await Session.create({})
            const retry = await WorkflowExecutor.run({ sessionID: retried.id, workflowID: "retry" })
            expect(retry.status).toBe("error")
            expect(retry.attempts.fail).toBe(3)

            const skipped = await Session.create({})
            const cont = await WorkflowExecutor.run({ sessionID: skipped.id, workflowID: "continue" })
            expect(cont.status).toBe("completed")
            expect(cont.attempts.fail).toBe(1)
            expect(cont.variables.done).toBe(true)

            const stopped = await Session.create({})
            const abort = await WorkflowExecutor.run({ sessionID: stopped.id, workflowID: "abort" })
            expect(abort.status).toBe("error")
            expect(abort.error).toContain("ready")
            expect(WorkflowState.read((await Session.get(stopped.id)).dsl_context)?.status).toBe("error")
          },
        }),
    })
  })

  test("marks DAG dependents skipped when a continue node fails", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "dag-block",
      name: "Dag Block",
      nodes: [
        {
          id: "fail",
          prompt: "Fail",
          error_policy: { strategy: "continue", max_attempts: 1 },
        },
        { id: "blocked", depends_on: ["fail"], outputs: { blocked: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({
              sessionID: session.id,
              workflowID: "dag-block",
              execute: async () => {
                throw new Error("boom")
              },
            })

            expect(state.status).toBe("error")
            expect(state.statuses.fail).toBe("error")
            expect(state.statuses.blocked).toBe("skipped")
            expect(state.completed).toEqual([])
            expect(state.variables.blocked).toBeUndefined()
          },
        }),
    })
  })

  test("continues independent DAG branches after a continue node fails", async () => {
    await using tmp = await tmpdir()
    const space = WorkspaceID.ascending()
    await workflow(tmp.path, {
      id: "dag-continue",
      name: "Dag Continue",
      nodes: [
        {
          id: "fail",
          prompt: "Fail",
          error_policy: { strategy: "continue", max_attempts: 1 },
        },
        { id: "blocked", depends_on: ["fail"], outputs: { blocked: true } },
        { id: "free", outputs: { free: true } },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            const state = await WorkflowExecutor.run({
              sessionID: session.id,
              workflowID: "dag-continue",
              execute: async () => {
                throw new Error("boom")
              },
            })

            expect(state.status).toBe("error")
            expect(state.statuses.fail).toBe("error")
            expect(state.statuses.blocked).toBe("skipped")
            expect(state.statuses.free).toBe("completed")
            expect(state.variables.free).toBe(true)
            expect(state.variables.blocked).toBeUndefined()
          },
        }),
    })
  })
})
