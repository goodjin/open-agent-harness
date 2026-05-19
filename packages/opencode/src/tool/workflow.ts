import path from "path"
import z from "zod"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { WorkflowExecutor } from "@/workflow/executor"
import { WorkflowParser } from "@/workflow/parser"
import { Workflow } from "@/workflow/schema"
import type { WorkflowState } from "@/workflow/state"
import { Tool } from "./tool"

function file(id: string) {
  return path.join(Instance.directory, ".opencode", "workflows", `${id}.json`)
}

function result(state: WorkflowState.Info) {
  const statuses = Object.values(state.statuses)
  const completed = statuses.filter((status) => status === "completed").length
  const failed = statuses.filter((status) => status === "error").length
  const running = statuses.filter((status) => status === "running" || status === "ready").length
  const skipped = statuses.filter((status) => status === "skipped" || status === "cancelled").length
  const pending = statuses.filter((status) => status === "pending").length
  const summary = {
    total: state.total,
    completed,
    succeeded: completed,
    failed,
    running,
    skipped,
    pending,
    message:
      state.status === "completed"
        ? "Workflow execution completed. Use node outputs as the task result and summarize them; do not repeat completed node work unless a node output is missing or insufficient."
        : state.status === "error"
          ? "Workflow execution failed. Inspect failed node records before deciding whether to revise the workflow, retry, or stop."
          : state.status === "waiting_user" || state.status === "waiting_permission"
            ? "Workflow execution is paused. Report the pause reason and wait for resume input."
            : "Workflow execution started in the background. Do not manually execute workflow nodes. The runtime will post a workflow result back into this session when the run completes, fails, or pauses.",
  }
  return {
    run_id: state.runID,
    workflow_id: state.workflowID,
    workflow_name: state.workflowName,
    status: state.status,
    summary,
    current: state.current,
    step: state.step,
    total: state.total,
    completed: state.completed,
    attempts: state.attempts,
    nodes: state.nodes,
    statuses: state.statuses,
    variables: state.variables,
    pause: state.pause,
    error: state.error,
    checkpoint: state.checkpoint,
    time: state.time,
    next_action:
      state.status === "completed"
        ? "summarize_result"
        : state.status === "waiting_user" || state.status === "waiting_permission"
          ? "ask_or_resume"
          : state.status === "error"
            ? "revise_workflow_or_abort"
            : "wait_for_workflow_result",
  }
}

export const WorkflowCreateTool = Tool.define("workflow_create", {
  description: [
    "Create and persist a workflow DAG for the current session.",
    "This is the model-facing workflow.create operation.",
    "It validates and saves the workflow but does not start execution.",
    "Call workflow_start after this only when the user asked to execute the task.",
  ].join("\n"),
  parameters: z.object({
    workflow: Workflow.Definition.describe("The workflow DAG definition to validate and persist"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "workflow_create",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const workflow = Workflow.Definition.parse(params.workflow)
    const parsed = WorkflowParser.parse(workflow)
    await Filesystem.writeJson(file(parsed.id), workflow)

    return {
      title: parsed.name,
      metadata: {
        status: "ready",
        workflow: {
          id: parsed.id,
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          steps: parsed.steps.map((step) => ({
            id: step.id,
            type: step.type,
            capabilities: step.capabilities,
            agent: step.agent,
            mutates: step.mutates,
            next: step.next,
            verification: step.verification,
            depends_on: step.depends_on,
          })),
        },
        path: file(parsed.id),
      },
      output: JSON.stringify(
        {
          status: "ready",
          workflow_id: parsed.id,
          workflow_name: parsed.name,
          nodes: parsed.nodes.map((step) => step.id),
          path: file(parsed.id),
          next_action: "workflow_start",
        },
        null,
        2,
      ),
    }
  },
})

export const WorkflowStartTool = Tool.define("workflow_start", {
  description: [
    "Start executing a persisted workflow DAG in the background and return immediately.",
    "This is the model-facing workflow.start operation.",
    "Do not manually execute workflow nodes after this returns active; the runtime will post the completed, failed, or paused result back into the session for the model to continue.",
  ].join("\n"),
  parameters: z.object({
    workflow_id: z.string().min(1).describe("The id returned by workflow_create"),
    variables: z.record(z.string(), z.unknown()).optional().describe("Optional runtime variables for workflow inputs"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "workflow_start",
      patterns: [params.workflow_id],
      always: ["*"],
      metadata: {},
    })

    const state = await WorkflowExecutor.begin({
      sessionID: ctx.sessionID,
      workflowID: params.workflow_id,
      variables: params.variables,
      agent: ctx.agent,
    })
    const out = result(state)

    return {
      title: `${state.workflowName}: ${state.status}`,
      metadata: {
        state,
        result: out,
      },
      output: JSON.stringify(out, null, 2),
    }
  },
})
