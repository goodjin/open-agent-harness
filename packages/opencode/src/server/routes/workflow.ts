import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { SessionID } from "@/session/schema"
import { WorkflowExecutor } from "@/workflow/executor"
import { WorkflowState } from "@/workflow/state"
import { Workflow } from "@/workflow/schema"
import { errors } from "../error"
import { lazy } from "@/util/lazy"

const Run = z.object({
  sessionID: SessionID.zod,
  workflowID: z.string(),
  variables: z.record(z.string(), z.unknown()).optional(),
})

const Resume = z.object({
  sessionID: SessionID.zod,
  variables: z.record(z.string(), z.unknown()).optional(),
  approved: z.boolean().optional(),
})

export const WorkflowRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List workflows",
        description: "List available workflow DSL definitions.",
        operationId: "workflow.list",
        responses: {
          200: {
            description: "Workflow definitions",
            content: {
              "application/json": {
                schema: resolver(Workflow.Summary.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await WorkflowExecutor.list()),
    )
    .get(
      "/run",
      describeRoute({
        summary: "List workflow runs",
        description: "List workflow runs stored in session dsl_context.",
        operationId: "workflow.runs",
        responses: {
          200: {
            description: "Workflow runs",
            content: {
              "application/json": {
                schema: resolver(WorkflowState.Info.array()),
              },
            },
          },
          ...errors(400, 403),
        },
      }),
      async (c) => c.json(await WorkflowExecutor.runs()),
    )
    .post(
      "/run",
      describeRoute({
        summary: "Run workflow",
        description: "Create and execute a workflow run for a session.",
        operationId: "workflow.run",
        responses: {
          200: {
            description: "Workflow run",
            content: {
              "application/json": {
                schema: resolver(WorkflowState.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
        requestBody: {
          required: true,
          content: {},
        },
      }),
      validator("json", Run),
      async (c) => c.json(await WorkflowExecutor.run(c.req.valid("json"))),
    )
    .post(
      "/resume",
      describeRoute({
        summary: "Resume workflow",
        description: "Resume a paused workflow after user input or permission approval.",
        operationId: "workflow.resume",
        responses: {
          200: {
            description: "Workflow run",
            content: {
              "application/json": {
                schema: resolver(WorkflowState.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
        requestBody: {
          required: true,
          content: {},
        },
      }),
      validator("json", Resume),
      async (c) => c.json(await WorkflowExecutor.resume(c.req.valid("json"))),
    )
    .get(
      "/:sessionID/status",
      describeRoute({
        summary: "Get workflow status",
        description: "Get the workflow run stored for a session.",
        operationId: "workflow.status",
        responses: {
          200: {
            description: "Workflow run status",
            content: {
              "application/json": {
                schema: resolver(WorkflowState.Info.nullable()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => c.json((await WorkflowExecutor.status(c.req.valid("param").sessionID)) ?? null),
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort workflow",
        description: "Abort the workflow run stored for a session.",
        operationId: "workflow.abort",
        responses: {
          200: {
            description: "Workflow run",
            content: {
              "application/json": {
                schema: resolver(WorkflowState.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => c.json(await WorkflowExecutor.abort(c.req.valid("param").sessionID)),
    ),
)
