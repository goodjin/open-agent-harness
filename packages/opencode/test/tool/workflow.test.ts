import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
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

  test("workflow_start runs a persisted workflow and returns model-visible results", async () => {
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

            expect(result.metadata.state.status).toBe("completed")
            expect(result.metadata.state.completed).toEqual(["first", "second"])
            expect(result.metadata.state.variables.second).toBe("done")
            expect(output.status).toBe("completed")
            expect(output.summary.total).toBe(2)
            expect(output.summary.completed).toBe(2)
            expect(output.summary.succeeded).toBe(2)
            expect(output.summary.failed).toBe(0)
            expect(output.summary.message).toContain("do not repeat completed node work")
            expect(output.completed).toEqual(["first", "second"])
            expect(output.variables.second).toBe("done")
          },
        }),
    })
  })
})
