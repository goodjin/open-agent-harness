import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Audit } from "@/observability/audit"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { ForbiddenError } from "@/storage/db"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const AuditRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Query audit log",
      description: "Query sanitized audit records for the current project directory.",
      operationId: "audit.list",
      responses: {
        200: {
          description: "Audit records",
          content: {
            "application/json": {
              schema: resolver(Audit.Record.array()),
            },
          },
        },
        ...errors(400, 403, 404),
      },
    }),
    validator(
      "query",
      Audit.Query,
    ),
    async (c) => {
      const query = c.req.valid("query")
      if (query.projectID && query.projectID !== Instance.project.id) {
        throw new ForbiddenError({ message: `Project ${query.projectID} does not belong to the current directory` })
      }
      if (query.sessionID) await Session.get(query.sessionID)
      return c.json(Audit.query(query))
    },
  ),
)
