import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Memory, MemoryStore } from "@/memory"
import { Session } from "@/session"
import { ForbiddenError } from "@/storage/db"
import { errors } from "../error"
import { lazy } from "@/util/lazy"

export const MemoryRoutes = lazy(() =>
  new Hono().post(
    "/search",
    describeRoute({
      summary: "Search memories",
      description: "Search ranked project memories with optional session and topic filters.",
      operationId: "memory.search",
      responses: {
        200: {
          description: "Ranked memories",
          content: {
            "application/json": {
              schema: resolver(Memory.SearchResult.array()),
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
    validator("json", Memory.SearchInput),
    async (c) => {
      const body = c.req.valid("json")
      const session = body.sessionID ? await Session.get(body.sessionID) : undefined
      if (session?.parentID) {
        throw new ForbiddenError({ message: "child session memory cannot be searched over HTTP" })
      }
      const result = await MemoryStore.search(body)
      return c.json(result)
    },
  ),
)
