import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { AgentManage } from "@/agent/manage"
import { errors } from "../error"
import { lazy } from "@/util/lazy"

export const AgentRoutes = lazy(() =>
  new Hono()
    .get(
      "/manage",
      describeRoute({
        summary: "List manageable agents",
        description: "List all agent templates and management state, including disabled agents.",
        operationId: "agent.manage.list",
        responses: {
          200: {
            description: "Manageable agents",
            content: {
              "application/json": {
                schema: resolver(AgentManage.Info.array()),
              },
            },
          },
          ...errors(400, 403),
        },
      }),
      async (c) => c.json(await AgentManage.list()),
    )
    .post(
      "/manage/validate",
      describeRoute({
        summary: "Validate an agent template",
        description: "Validate agent template metadata before saving.",
        operationId: "agent.manage.validate",
        responses: {
          200: {
            description: "Validation result",
            content: {
              "application/json": {
                schema: resolver(AgentManage.ValidateOutput),
              },
            },
          },
          ...errors(400, 403),
        },
        requestBody: {
          required: true,
          content: {},
        },
      }),
      validator("json", AgentManage.ValidateInput),
      async (c) => c.json(await AgentManage.check(c.req.valid("json"))),
    )
    .post(
      "/manage",
      describeRoute({
        summary: "Create an agent template",
        description: "Create a user or project agent template.",
        operationId: "agent.manage.create",
        responses: {
          200: {
            description: "Created agent",
            content: {
              "application/json": {
                schema: resolver(AgentManage.Info),
              },
            },
          },
          ...errors(400, 403, 409),
        },
        requestBody: {
          required: true,
          content: {},
        },
      }),
      validator("json", AgentManage.SaveInput),
      async (c) => c.json(await AgentManage.create(c.req.valid("json"))),
    )
    .get(
      "/manage/:id",
      describeRoute({
        summary: "Get manageable agent",
        description: "Get one agent template with management state.",
        operationId: "agent.manage.get",
        responses: {
          200: {
            description: "Manageable agent",
            content: {
              "application/json": {
                schema: resolver(AgentManage.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await AgentManage.get(c.req.valid("param").id)),
    )
    .patch(
      "/manage/:id",
      describeRoute({
        summary: "Update an agent template",
        description: "Update a user or project agent template, creating an override for package templates.",
        operationId: "agent.manage.update",
        responses: {
          200: {
            description: "Updated agent",
            content: {
              "application/json": {
                schema: resolver(AgentManage.Info),
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
      validator("param", z.object({ id: z.string() })),
      validator("json", AgentManage.PatchInput),
      async (c) => c.json(await AgentManage.update(c.req.valid("param").id, c.req.valid("json"))),
    )
    .patch(
      "/manage/:id/state",
      describeRoute({
        summary: "Update agent state",
        description: "Enable or disable an agent through config overlay state.",
        operationId: "agent.manage.state",
        responses: {
          200: {
            description: "Updated agent",
            content: {
              "application/json": {
                schema: resolver(AgentManage.Info),
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
      validator("param", z.object({ id: z.string() })),
      validator("json", AgentManage.StateInput),
      async (c) => c.json(await AgentManage.state(c.req.valid("param").id, c.req.valid("json"))),
    ),
)
