import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { WorkflowState } from "../../src/workflow/state"
import { tmpdir } from "../fixture/fixture"

function ctx(sessionID: Session.Info["id"]): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "workflow-runner",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

async function wait(sessionID: Session.Info["id"], status: WorkflowState.Info["status"]) {
  for (let i = 0; i < 50; i++) {
    const state = WorkflowState.read((await Session.get(sessionID)).dsl_context)
    if (state?.status === status) return state
    await Bun.sleep(10)
  }
  throw new Error(`Workflow did not reach ${status}`)
}

async function assistant(sessionID: Session.Info["id"]) {
  for (let i = 0; i < 50; i++) {
    for await (const msg of MessageV2.stream(sessionID)) {
      if (msg.info.role === "assistant") return msg
    }
    await Bun.sleep(10)
  }
  throw new Error("Workflow notification was not created")
}

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }

describe("workflow tools", () => {
  test("workflow_create persists a workflow without starting it", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const tool = (await ToolRegistry.tools(model)).find((item) => item.id === "workflow_create")
            expect(tool).toBeDefined()

            const result = await tool!.execute(
              {
                workflow: {
                  id: "created",
                  name: "Created",
                  steps: [{ id: "first", outputs: { done: true } }],
                },
              },
              ctx(session.id),
            )

            expect(await Bun.file(path.join(tmp.path, ".opencode", "workflows", "created.json")).exists()).toBe(true)
            expect(WorkflowState.read((await Session.get(session.id)).dsl_context)).toBeUndefined()
            expect(result.metadata.workflow.id).toBe("created")
            expect(result.metadata.status).toBe("ready")
            expect(JSON.parse(result.output).next_action).toBe("workflow_start")
          },
        }),
    })
  })

  test("workflow_start starts a persisted workflow in the background", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const user = MessageID.ascending()
            await Session.updateMessage({
              id: user,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "workflow-runner",
              model,
              tools: {},
              mode: "",
            } as MessageV2.User)
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: user,
              sessionID: session.id,
              type: "text",
              text: "run started",
            })
            const tools = await ToolRegistry.tools(model)
            const create = tools.find((item) => item.id === "workflow_create")!
            const start = tools.find((item) => item.id === "workflow_start")!

            await create.execute(
              {
                workflow: {
                  id: "started",
                  name: "Started",
                  steps: [
                    { id: "first", outputs: { first: "done" } },
                    { id: "second", outputs: { second: "$first" } },
                  ],
                },
              },
              ctx(session.id),
            )

            const result = await start.execute({ workflow_id: "started" }, ctx(session.id))
            const output = JSON.parse(result.output)

            expect(result.metadata.state.status).toBe("active")
            expect(output.status).toBe("active")
            expect(output.summary.total).toBe(2)
            expect(output.summary.completed).toBe(0)
            expect(output.summary.succeeded).toBe(0)
            expect(output.summary.failed).toBe(0)
            expect(output.summary.message).toContain("started in the background")
            expect(output.next_action).toBe("wait_for_workflow_result")

            const state = await wait(session.id, "completed")
            expect(state.completed).toEqual(["first", "second"])
            expect(state.variables.second).toBe("done")
            const note = await assistant(session.id)
            expect(note.info.role).toBe("assistant")
            if (note.info.role !== "assistant") throw new Error("Expected workflow notification assistant")
            expect(note.info.parentID).toBe(user)
            expect(note.parts.some((part) => part.type === "text" && part.text.includes("Workflow Started: completed"))).toBe(
              true,
            )
          },
        }),
    })
  })

  test("workflow_start summarizes DAG failed, skipped, and completed nodes", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const tools = await ToolRegistry.tools(model)
            const create = tools.find((item) => item.id === "workflow_create")!
            const start = tools.find((item) => item.id === "workflow_start")!

            await create.execute(
              {
                workflow: {
                  id: "dag-started",
                  name: "Dag Started",
                  nodes: [
                    {
                      id: "fail",
                      error_policy: { strategy: "continue", max_attempts: 1 },
                      guards: [{ type: "variable", name: "ready", exists: true }],
                    },
                    { id: "blocked", depends_on: ["fail"], outputs: { blocked: true } },
                    { id: "free", outputs: { free: true } },
                  ],
                },
              },
              ctx(session.id),
            )

            const result = await start.execute({ workflow_id: "dag-started" }, ctx(session.id))
            const output = JSON.parse(result.output)

            expect(output.status).toBe("active")

            const state = await wait(session.id, "error")
            const statuses = Object.values(state.statuses)
            expect(statuses.filter((status) => status === "completed")).toHaveLength(1)
            expect(statuses.filter((status) => status === "error")).toHaveLength(1)
            expect(statuses.filter((status) => status === "skipped")).toHaveLength(1)
            expect(state.statuses).toMatchObject({
              fail: "error",
              blocked: "skipped",
              free: "completed",
            })
            expect(state.variables.free).toBe(true)
            expect(state.variables.blocked).toBeUndefined()
          },
        }),
    })
  })
})
