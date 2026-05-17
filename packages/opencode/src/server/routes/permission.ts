import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Policy } from "@/permission/policy"
import { PermissionID } from "@/permission/schema"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { ForbiddenError, NotFoundError } from "@/storage/db"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

const InspectRule = Policy.Rule.pick({
  dimension: true,
  permission: true,
  pattern: true,
  action: true,
  source: true,
})

const InspectResponse = z
  .object({
    sessionID: SessionID.zod,
    agent: z.string(),
    policy: z.object({
      rules: InspectRule.array(),
    }),
    trace: z
      .object({
        action: Policy.Action,
        rule: InspectRule,
        index: z.number(),
        matched: InspectRule.array(),
      })
      .optional(),
  })
  .meta({
    ref: "PermissionInspect",
  })

export const PermissionRoutes = lazy(() =>
  new Hono()
    .get(
      "/inspect",
      describeRoute({
        summary: "Inspect effective permissions",
        description: "Get the effective read-only permission policy and optional decision trace for a session and agent.",
        operationId: "permission.inspect",
        responses: {
          200: {
            description: "Effective permission policy",
            content: {
              "application/json": {
                schema: resolver(InspectResponse),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: SessionID.zod,
          agent: z.string().min(1),
          permission: z.string().min(1).optional(),
          pattern: z.string().min(1).default("*"),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const session = await Session.get(query.sessionID)
        const agent = await Agent.get(query.agent)
        if (!agent) return c.notFound()
        const policy = Policy.merge(
          agent.policy ?? Policy.fromLegacy(agent.permission, "agent"),
          Policy.fromLegacy(session.permission ?? [], "session"),
        )
        const trace = query.permission ? Policy.evaluate(policy, query.permission, query.pattern) : undefined
        return c.json({
          sessionID: session.id,
          agent: agent.name,
          policy: {
            rules: policy.rules,
          },
          trace: trace
            ? {
                action: trace.action,
                rule: trace.rule,
                index: trace.index,
                matched: trace.matched,
              }
            : undefined,
        })
      },
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ reply: PermissionNext.Reply, message: z.string().optional() })),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        const result = await PermissionNext.reply({
          requestID: params.requestID,
          reply: json.reply,
          message: json.message,
        })
        if (result.type === "not_found") throw new NotFoundError({ message: `Permission request not found: ${params.requestID}` })
        if (result.type === "forbidden") {
          throw new ForbiddenError({ message: `Permission request does not belong to the current directory` })
        }
        return c.json(true)
      },
    )
    .get(
      "/session/:sessionID",
      describeRoute({
        summary: "List pending permissions for a session",
        description: "Get pending permission requests for the current directory and session.",
        operationId: "permission.listBySession",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(PermissionNext.Request.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.get(params.sessionID)
        const permissions = await PermissionNext.list({ sessionID: params.sessionID })
        return c.json(permissions)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get pending permission requests for the current directory.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(PermissionNext.Request.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: SessionID.zod.optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        if (query.sessionID) await Session.get(query.sessionID)
        const permissions = await PermissionNext.list(query.sessionID ? { sessionID: query.sessionID } : undefined)
        return c.json(permissions)
      },
    ),
)
