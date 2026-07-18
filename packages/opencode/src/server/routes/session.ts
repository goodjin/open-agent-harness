import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SessionID, MessageID, PartID } from "@/session/schema"
import z from "zod"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { SessionPrompt } from "../../session/prompt"
import { SessionCompaction } from "../../session/compaction"
import { SessionRevert } from "../../session/revert"
import { SessionLog } from "../../session/log"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionDelegation } from "@/session/delegation"
import { SessionTimeline } from "../../session/timeline"
import { SessionRuns } from "../../session/runs"
import { SessionTask } from "../../session/task"
import { SessionTaskHandoff } from "../../session/task-handoff"
import { SessionTaskConfirmation } from "../../session/task-confirmation"
import { Todo } from "../../session/todo"
import { Agent } from "../../agent/agent"
import { Snapshot } from "@/snapshot"
import { Log } from "../../util/log"
import { PermissionNext } from "@/permission/next"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { ForbiddenError, NotFoundError } from "@/storage/db"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const log = Log.create({ service: "server" })
const max = {
  ignored: 2_000,
  output: 20_000,
  metadata: 20_000,
}

function trim(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`
}

function external(input: SessionPrompt.PromptInput["metadata"]) {
  if (!input) return
  const metadata = { ...input }
  delete metadata.internal
  delete metadata.source
  delete metadata.run_id
  delete metadata.turn
  delete metadata.task_update_proposal
  delete metadata.task_update_progress
  return metadata
}

async function restorable(sessionID: SessionID, status: SessionStatus.Info) {
  if (
    (status.type === "error" || status.type === "timeout" || status.type === "failed") &&
    status.reason === "transport" &&
    status.recoverable === true
  )
    return true
  if (status.type !== "error" && status.type !== "timeout" && status.type !== "failed") return false
  const msg = await assistant(sessionID)
  if (!msg || msg.info.role !== "assistant" || !msg.info.error) return false
  const text = msg.parts.some((part) => part.type === "text" && part.text.trim().length > 0)
  if (text) return false
  const tools = msg.parts.some(
    (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
  )
  return !tools
}

async function assistant(sessionID: SessionID) {
  const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID)).catch(() => [])
  return msgs.findLast((msg) => msg.info.role === "assistant")
}

function size(value: unknown) {
  return JSON.stringify(value).length
}

function meta(value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (size(item) <= max.metadata) return [key, item]
      return [key, { omitted: true, bytes: size(item) }]
    }),
  )
}

function part(part: MessageV2.Part): MessageV2.Part {
  if (part.type === "step-start") {
    return {
      id: part.id,
      sessionID: part.sessionID,
      messageID: part.messageID,
      type: part.type,
      snapshot: part.snapshot,
    }
  }

  if (part.type === "text" && part.ignored) {
    return {
      ...part,
      text: trim(part.text, max.ignored),
      metadata: meta(part.metadata),
    }
  }

  if (part.type === "reasoning") {
    return {
      ...part,
      metadata: meta(part.metadata),
    }
  }

  if (part.type === "tool") {
    const state =
      part.state.status === "completed"
        ? {
            ...part.state,
            output: trim(part.state.output, max.output),
            metadata: meta(part.state.metadata) ?? {},
          }
        : part.state.status === "running"
          ? {
              ...part.state,
              metadata: meta(part.state.metadata),
            }
          : part.state
    return {
      ...part,
      state,
      metadata: meta(part.metadata),
    }
  }

  return part
}

function slim(session: Session.Info): Session.Info {
  return {
    ...session,
    dsl_context: undefined,
  }
}

function view(message: MessageV2.WithParts): MessageV2.WithParts {
  return {
    info:
      message.info.role === "user" && message.info.summary?.diffs
        ? {
            ...message.info,
            summary: {
              ...message.info.summary,
              diffs: SessionSummary.slim(message.info.summary.diffs),
            },
          }
        : message.info,
    parts: message.parts.map(part),
  }
}

const CommandSource = z.enum(["user", "parent_session", "runtime"])

const TreeBatch = z.object({
  directory: z.string().optional(),
  ids: SessionID.zod.array().min(1),
})

const Confirmation = z
  .object({
    proposal_id: z.string().min(3),
    revision_id: z.string().min(1).optional(),
    action: z.enum(["confirm", "cancel"]),
    assignment_id: z.string().min(1).optional(),
    status: z.string().optional(),
    target_session_id: SessionID.zod.optional(),
    target_task_id: z.string().min(1).optional(),
  })
  .strict()
  .meta({ ref: "SessionTaskConfirmation" })

function command(input: {
  source: z.infer<typeof CommandSource>
  source_session?: SessionID
  target_session: SessionID
  intent: string
  reason?: string
  expected_action: string
  message?: string
}) {
  return [
    "[Session Command]",
    `source: ${input.source}`,
    input.source_session ? `source_session: ${input.source_session}` : undefined,
    `target_session: ${input.target_session}`,
    `intent: ${input.intent}`,
    input.reason ? `reason: ${input.reason}` : undefined,
    `expected_action: ${input.expected_action}`,
    "",
    input.message ?? "",
  ]
    .filter((item): item is string => typeof item === "string")
    .join("\n")
}

function bound(session: Session.Info) {
  if (session.agent) return session.agent
  const record = (input: unknown): input is Record<string, unknown> =>
    typeof input === "object" && input !== null && !Array.isArray(input)
  const protocol = session.dsl_context?.protocol
  if (!record(protocol)) return undefined
  const delegation = protocol.delegation
  if (!record(delegation)) return undefined
  return typeof delegation.agent === "string" ? delegation.agent : undefined
}

async function scoped<T>(directory: string | undefined, fn: () => Promise<T>) {
  if (!directory) return fn()
  return WorkspaceContext.provide({
    workspaceID: undefined,
    fn: () =>
      Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn,
      }),
  })
}

export const SessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessions: Session.Info[] = []
        for await (const session of Session.list({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })) {
          sessions.push(slim(session))
        }
        const tasks = SessionTask.summaries(sessions.map((session) => session.id))
        return c.json(sessions.map((session) => ({ ...session, task: tasks.get(session.id) })))
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions in the current or requested project directory.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const result = await scoped(query.directory, async () => SessionStatus.list())
        return c.json(result)
      },
    )
    .post(
      "/descendants",
      describeRoute({
        summary: "Get session descendants for multiple roots",
        tags: ["Session"],
        description: "Retrieve all nested child sessions for the specified parent sessions in one directory scan.",
        operationId: "session.descendantsBatch",
        responses: {
          200: {
            description: "List of descendants",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "json",
        z.object({
          directory: z.string().optional(),
          ids: SessionID.zod.array().min(1),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const sessions = await (body.directory
          ? WorkspaceContext.provide({
              workspaceID: undefined,
              fn: () =>
                Instance.provide({
                  directory: body.directory!,
                  init: InstanceBootstrap,
                  fn: () => Session.descendantsBatch({ ids: body.ids }),
                }),
            })
          : Session.descendantsBatch({ ids: body.ids }))
        return c.json(sessions.map(slim))
      },
    )
    .get(
      "/tree",
      describeRoute({
        summary: "Get lightweight session tree",
        tags: ["Session"],
        description: "Retrieve a lightweight session tree projection without message bodies or raw session metadata.",
        operationId: "session.tree",
        responses: {
          200: {
            description: "Session tree projection",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    nodes: Session.TreeNode.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "query",
        z.object({
          root: SessionID.zod,
          directory: z.string().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json({
          nodes: await scoped(query.directory, () => Session.tree(query.root)),
        })
      },
    )
    .patch(
      "/tree/sessions",
      describeRoute({
        summary: "Update session tree nodes",
        tags: ["Session"],
        description: "Batch update lightweight session tree metadata such as title, agent, and model preference.",
        operationId: "session.tree.update",
        responses: {
          200: {
            description: "Updated sessions",
            content: {
              "application/json": {
                schema: resolver(z.object({ updated: z.number() })),
              },
            },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator(
        "json",
        TreeBatch.extend({
          title: z.string().optional(),
          agent: z.string().optional(),
          confirm: z.boolean().optional(),
          model: z
            .object({
              providerID: ProviderID.zod,
              modelID: ModelID.zod,
            })
            .optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        await scoped(body.directory, async () => {
          await Promise.all(
            body.ids.map(async (id) => {
              await Session.get(id)
              if (body.title !== undefined) await Session.setTitle({ sessionID: id, title: body.title })
              if (body.agent !== undefined)
                await Session.setAgent({ sessionID: id, agent: body.agent, confirm: body.confirm })
              if (body.model) await Session.setModel({ sessionID: id, model: body.model, confirm: body.confirm })
            }),
          )
        })
        return c.json({ updated: body.ids.length })
      },
    )
    .post(
      "/tree/abort",
      describeRoute({
        summary: "Abort session tree nodes",
        tags: ["Session"],
        description: "Abort selected sessions from the session tree manager.",
        operationId: "session.tree.abort",
        responses: {
          200: {
            description: "Aborted sessions",
            content: {
              "application/json": {
                schema: resolver(z.object({ aborted: z.number() })),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "json",
        TreeBatch.extend({
          source: CommandSource.optional(),
          source_session: SessionID.zod.optional(),
          reason: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const aborted = await scoped(body.directory, async () => {
          const done = new Set([
            "completed",
            "terminal_reply",
            "user_completed",
            "archived",
            "failed",
            "error",
            "timeout",
          ])
          const result = await Promise.all(
            body.ids.map(async (id) => {
              await Session.get(id)
              if (done.has(SessionStatus.get(id).type)) return false
              SessionPrompt.cancel(id)
              SessionStatus.set(id, { type: "aborted", message: body.reason })
              return true
            }),
          )
          return result.filter(Boolean).length
        })
        return c.json({ aborted })
      },
    )
    .post(
      "/tree/resume",
      describeRoute({
        summary: "Resume session tree nodes",
        tags: ["Session"],
        description: "Restore interrupted sessions or send structured resume commands from the session tree manager.",
        operationId: "session.tree.resume",
        responses: {
          200: {
            description: "Resumed sessions",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    resumed: z.number(),
                    restored: z.number().optional(),
                    messaged: z.number().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "json",
        TreeBatch.extend({
          source: CommandSource.optional(),
          source_session: SessionID.zod.optional(),
          include_completed: z.boolean().optional(),
          mode: z.enum(["restore", "message", "auto"]).optional(),
          reason: z.string().optional(),
          message: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const mode = body.mode ?? "restore"
        const done = new Set(["completed", "terminal_reply", "user_completed"])
        const restore = new Set(["interrupted", "queued", "rate_limited", "retry", "running", "starting"])
        const resumed = await scoped(body.directory, async () => {
          const result = await Promise.all(
            body.ids.map(async (id) => {
              const info = await Session.get(id)
              const status = SessionStatus.get(id)
              const recoverable = restore.has(status.type) || (await restorable(id, status))
              if ((mode === "restore" || mode === "auto") && recoverable) {
                SessionStatus.set(id, { type: "running" })
                void SessionPrompt.loop({ sessionID: id }).catch((err) => {
                  log.warn("session tree restore failed", { sessionID: id, err })
                  SessionStatus.set(id, { type: "error", message: err instanceof Error ? err.message : String(err) })
                })
                return "restore" as const
              }
              if (mode === "restore") return false
              if (status.type === "archived") return false
              if (mode === "message" && !body.include_completed && done.has(status.type)) return false
              const meta = {
                command: {
                  source: body.source ?? "user",
                  source_session: body.source_session,
                  target_session: id,
                  intent: "resume_aborted_session",
                  reason: body.reason,
                },
              }
              void SessionPrompt.prompt({
                sessionID: id,
                agent: bound(info),
                metadata: meta,
                parts: [
                  {
                    type: "text",
                    text:
                      mode === "auto"
                        ? "继续"
                        : command({
                            source: body.source ?? "user",
                            source_session: body.source_session,
                            target_session: id,
                            intent: "resume_aborted_session",
                            reason: body.reason,
                            expected_action:
                              "Continue from the last recoverable state, report blockers if recovery is not possible.",
                            message: body.message,
                          }),
                  },
                ],
              }).catch((err) => {
                log.warn("session tree resume message failed", { sessionID: id, err })
                SessionStatus.set(id, { type: "error", message: err instanceof Error ? err.message : String(err) })
              })
              SessionStatus.set(id, { type: "running" })
              return "message" as const
            }),
          )
          return result
        })
        const restored = resumed.filter((item) => item === "restore").length
        const messaged = resumed.filter((item) => item === "message").length
        if (mode === "auto") return c.json({ resumed: restored + messaged, restored, messaged })
        return c.json({ resumed: restored + messaged })
      },
    )
    .get(
      "/:sessionID/status",
      describeRoute({
        summary: "Get single session status",
        description: "Retrieve the current persisted runtime status for one session. Missing status defaults to idle.",
        operationId: "session.getStatus",
        responses: {
          200: {
            description: "Get single session status",
            content: {
              "application/json": {
                schema: resolver(SessionStatus.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.get(sessionID)
        return c.json(SessionStatus.get(sessionID))
      },
    )
    .post(
      "/:sessionID/status/user-completed",
      describeRoute({
        summary: "Mark session as user completed",
        tags: ["Session"],
        description:
          "Mark a waiting, interrupted, failed, or otherwise unfinished session as completed by user decision.",
        operationId: "session.status.userCompleted",
        responses: {
          200: {
            description: "Updated session status",
            content: {
              "application/json": {
                schema: resolver(SessionStatus.Info),
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
      validator(
        "json",
        z.object({
          reason: z.string().optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await Session.get(sessionID)
        SessionPrompt.cancel(sessionID)
        SessionStatus.set(
          sessionID,
          { type: "user_completed", message: body.reason ?? "Marked complete by user." },
          { reason: body.reason ?? "User marked session complete." },
        )
        return c.json(SessionStatus.get(sessionID))
      },
    )
    .get(
      "/:sessionID/log",
      describeRoute({
        summary: "Get session log",
        description: "Retrieve structured runtime log records for a session, sorted chronologically.",
        tags: ["Session"],
        operationId: "session.log",
        responses: {
          200: {
            description: "Session log records",
            content: {
              "application/json": {
                schema: resolver(SessionLog.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      validator(
        "query",
        z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(5000).optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const query = c.req.valid("query")
        await Session.get(sessionID)
        await SessionLog.remove({ sessionID })
        return c.json(await SessionLog.list({ sessionID, cursor: query.cursor, limit: query.limit }))
      },
    )
    .get(
      "/:sessionID/log/payload/:payloadID",
      describeRoute({
        summary: "Get session log payload",
        description: "Retrieve a large payload referenced by a session log record.",
        tags: ["Session"],
        operationId: "session.log.payload",
        responses: {
          200: {
            description: "Session log payload",
            content: {
              "application/json": {
                schema: resolver(SessionLog.Payload),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
          payloadID: z.string().startsWith("payload_"),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.get(params.sessionID)
        const payload = await SessionLog.readPayload({ sessionID: params.sessionID, id: params.payloadID })
        if (!payload) throw new NotFoundError({ message: `Session log payload not found: ${params.payloadID}` })
        return c.json(payload)
      },
    )
    .get(
      "/:sessionID/protocol/:runID/trace",
      describeRoute({
        summary: "Get protocol trace",
        description: "Retrieve a structured Agent Protocol DSL trace for comparison with ordinary tool calls.",
        tags: ["Session"],
        operationId: "session.protocol.trace",
        responses: {
          200: {
            description: "Protocol trace",
            content: {
              "application/json": {
                schema: resolver(SessionLog.ProtocolTrace.nullable()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
          runID: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.get(params.sessionID)
        return c.json((await SessionLog.protocolTrace({ sessionID: params.sessionID, runID: params.runID })) ?? null)
      },
    )
    .get(
      "/:sessionID/task",
      describeRoute({
        summary: "Get the current session task",
        tags: ["Session"],
        operationId: "session.task.current",
        responses: {
          200: {
            description: "Current task",
            content: { "application/json": { schema: resolver(SessionTask.View) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.get(sessionID)
        const task = await SessionTask.current(sessionID)
        if (!task) throw new NotFoundError({ message: `Task not found for session: ${sessionID}` })
        return c.json(task)
      },
    )
    .get(
      "/:sessionID/task/history",
      describeRoute({
        summary: "List archived task revisions",
        tags: ["Session"],
        operationId: "session.task.history",
        responses: {
          200: {
            description: "Task history",
            content: { "application/json": { schema: resolver(SessionTask.History.array()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.get(sessionID)
        if (!(await SessionTask.get(sessionID)))
          throw new NotFoundError({ message: `Task not found for session: ${sessionID}` })
        return c.json(await SessionTask.history(sessionID))
      },
    )
    .get(
      "/:sessionID/task/revisions/:version",
      describeRoute({
        summary: "Get a task revision",
        tags: ["Session"],
        operationId: "session.task.revision",
        responses: {
          200: {
            description: "Task revision",
            content: { "application/json": { schema: resolver(SessionTask.RevisionView) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod, version: z.coerce.number().int().positive() })),
      async (c) => {
        const params = c.req.valid("param")
        await Session.get(params.sessionID)
        const revision = await SessionTask.revision(params.sessionID, params.version)
        if (!revision)
          throw new NotFoundError({ message: `Task revision not found: ${params.sessionID}/v${params.version}` })
        return c.json(revision)
      },
    )
    .post(
      "/:sessionID/task/update/confirm",
      describeRoute({
        summary: "Confirm or cancel a task update",
        tags: ["Session"],
        operationId: "session.task.update.confirm",
        responses: {
          200: {
            description: "Task update confirmation",
            content: { "application/json": { schema: resolver(Confirmation) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator(
        "json",
        z
          .object({
            proposal_id: z.string().min(3),
            revision_id: z.string().min(1),
            action: z.enum(["confirm", "cancel"]),
          })
          .strict(),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        await Session.get(params.sessionID)
        const task = await SessionTask.get(params.sessionID)
        if (!task) throw new NotFoundError({ message: `Task not found for session: ${params.sessionID}` })
        if (!SessionTask.owns(params.sessionID, body.revision_id))
          throw new ForbiddenError({ message: `Task revision does not belong to session: ${params.sessionID}` })
        return c.json({
          ...(await SessionTaskConfirmation.respond({
            sessionID: params.sessionID,
            proposalID: body.proposal_id,
            action: body.action,
            op: "update",
            revisionID: body.revision_id,
          })),
          revision_id: body.revision_id,
        })
      },
    )
    .post(
      "/:sessionID/task/handoff/:handoffID/confirm",
      describeRoute({
        summary: "Confirm or cancel a task handoff",
        tags: ["Session"],
        operationId: "session.task.handoff.confirm",
        responses: {
          200: {
            description: "Task handoff confirmation",
            content: { "application/json": { schema: resolver(Confirmation) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod, handoffID: z.string().min(1) })),
      validator("json", z.object({ proposal_id: z.string().min(3), action: z.enum(["confirm", "cancel"]) }).strict()),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        await Session.get(params.sessionID)
        const handoff = await SessionTaskHandoff.get(params.handoffID)
        if (!handoff) throw new NotFoundError({ message: `Task handoff not found: ${params.handoffID}` })
        if (handoff.source_session_id !== params.sessionID)
          throw new ForbiddenError({ message: `Task handoff does not belong to session: ${params.sessionID}` })
        return c.json(
          await SessionTaskConfirmation.respond({
            sessionID: params.sessionID,
            proposalID: body.proposal_id,
            action: body.action,
            op: "handoff",
            handoffID: handoff.id,
          }),
        )
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("SEARCH", { url: c.req.url })
        const session = await Session.get(sessionID)
        const task = SessionTask.summaries([sessionID]).get(sessionID)
        return c.json({ ...session, ...(task ? { task } : {}) })
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve direct child sessions for the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.children.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.children(sessionID)
        return c.json(session.map(slim))
      },
    )
    .post(
      "/:sessionID/delegations/submit",
      describeRoute({
        summary: "Submit delegated child results",
        tags: ["Session"],
        description: "Submit the current delegated child results and statuses for a parent session run.",
        operationId: "session.delegations.submit",
        responses: {
          200: {
            description: "Delegation results submitted",
            content: {
              "application/json": {
                schema: resolver(z.object({ submitted: z.boolean() })),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          directory: z.string().optional(),
          force: z.boolean().optional(),
          mode: z.enum(["cancel_without_result", "terminate_with_result"]).optional(),
          run_id: z.string().min(1),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const submitted = await scoped(body.directory, () =>
          SessionDelegation.submit({
            sessionID,
            runID: body.run_id,
            force: body.force,
            mode: body.mode,
          }),
        )
        return c.json({ submitted })
      },
    )
    .get(
      "/:sessionID/delegations/fallback-preview",
      describeRoute({
        summary: "Preview delegated child fallback result",
        tags: ["Session"],
        description:
          "Return the latest assistant text from a delegated child session for user-confirmed fallback handoff.",
        operationId: "session.delegations.fallbackPreview",
        responses: {
          200: {
            description: "Fallback preview",
            content: {
              "application/json": {
                schema: resolver(z.object({ messageID: MessageID.zod.optional(), text: z.string() })),
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
        const sessionID = c.req.valid("param").sessionID
        return c.json(await SessionDelegation.fallbackPreview({ sessionID }))
      },
    )
    .post(
      "/:sessionID/delegations/confirm-fallback",
      describeRoute({
        summary: "Confirm delegated child fallback result",
        tags: ["Session"],
        description: "Submit user-reviewed fallback text as the delegated child result and notify the parent session.",
        operationId: "session.delegations.confirmFallback",
        responses: {
          200: {
            description: "Fallback result confirmation",
            content: {
              "application/json": {
                schema: resolver(z.object({ submitted: z.boolean() })),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          edited: z.boolean().optional(),
          original_message_id: MessageID.zod.optional(),
          result: z.string().min(1),
          status: z.enum(["success", "failure", "reply"]).default("success"),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const submitted = await SessionDelegation.confirmFallback({
          sessionID,
          status: body.status,
          result: body.result,
          originalMessageID: body.original_message_id,
          edited: body.edited,
        })
        return c.json({ submitted })
      },
    )
    .post(
      "/:sessionID/delegations/cancel",
      describeRoute({
        summary: "Cancel delegated child sessions",
        tags: ["Session"],
        description:
          "Cancel pending delegated child sessions for a parent run and submit their statuses back to the parent.",
        operationId: "session.delegations.cancel",
        responses: {
          200: {
            description: "Delegated child sessions cancelled and submitted",
            content: {
              "application/json": {
                schema: resolver(z.object({ submitted: z.boolean() })),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          directory: z.string().optional(),
          reason: z.string().optional(),
          run_id: z.string().min(1),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const submitted = await scoped(body.directory, () =>
          SessionDelegation.cancel({
            sessionID,
            runID: body.run_id,
            reason: body.reason,
          }),
        )
        return c.json({ submitted })
      },
    )
    .get(
      "/:sessionID/descendants",
      describeRoute({
        summary: "Get session descendants",
        tags: ["Session"],
        description: "Retrieve all nested child sessions for the specified parent session.",
        operationId: "session.descendants",
        responses: {
          200: {
            description: "List of descendants",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.descendants.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.descendants(sessionID)
        return c.json(session.map(slim))
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
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
        const sessionID = c.req.valid("param").sessionID
        const todos = await Todo.get(sessionID)
        return c.json(todos)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.create.schema.optional()),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const session = await Session.create(body)
        return c.json(session)
      },
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.remove.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.remove(sessionID)
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const updates = c.req.valid("json")

        let session = await Session.get(sessionID)
        if (updates.title !== undefined) {
          session = await Session.setTitle({ sessionID, title: updates.title })
        }
        if (updates.time?.archived !== undefined) {
          session = await Session.setArchived({ sessionID, time: updates.time.archived })
        }

        return c.json(session)
      },
    )
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
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
      validator("json", Session.initialize.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await Session.initialize({ ...body, sessionID })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.fork.schema.shape.sessionID,
        }),
      ),
      validator("json", Session.fork.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const result = await Session.fork({ ...body, sessionID })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/status/dismiss",
      describeRoute({
        summary: "Dismiss session error status",
        description: "Clear a terminal error status without aborting unrelated active work.",
        operationId: "session.dismissStatus",
        responses: {
          200: {
            description: "Current session status",
            content: {
              "application/json": {
                schema: resolver(SessionStatus.Info),
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
        const sessionID = c.req.valid("param").sessionID
        await Session.get(sessionID)
        return c.json(SessionStatus.dismiss(sessionID))
      },
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
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
        SessionPrompt.cancel(c.req.valid("param").sessionID)
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        const sessionID = c.req.valid("param").sessionID
        await Session.share(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.diff.schema.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.diff.schema.shape.messageID,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const params = c.req.valid("param")
        const result = await SessionSummary.diff({
          sessionID: params.sessionID,
          messageID: query.messageID,
        })
        return c.json(result)
      },
    )
    .get(
      "/:sessionID/diff/detail",
      describeRoute({
        summary: "Get detailed file diff",
        description: "Get full before and after contents for one file diff in a session or message.",
        operationId: "session.diff.detail",
        responses: {
          200: {
            description: "Detailed file diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.nullable()),
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
      validator(
        "query",
        z.object({
          messageID: MessageID.zod.optional(),
          file: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const query = c.req.valid("query")
        await Session.get(params.sessionID)
        const result = await SessionSummary.detail({
          sessionID: params.sessionID,
          messageID: query.messageID,
          file: query.file,
        })
        return c.json(result)
      },
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.unshare.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.unshare(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
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
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const session = await Session.get(sessionID)
        await SessionRevert.cleanup(session)
        const msgs = await Session.messages({ sessionID })
        let currentAgent = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        if (!currentAgent) {
          return c.json({ error: "No agent available for compaction" }, { status: 400 })
        }
        await SessionCompaction.create({
          sessionID,
          agent: currentAgent,
          model: {
            providerID: body.providerID,
            modelID: body.modelID,
          },
          auto: body.auto,
        })
        await SessionPrompt.loop({ sessionID })
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
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
      validator(
        "query",
        z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .meta({ description: "Maximum number of messages to return" }),
            before: z
              .string()
              .optional()
              .meta({ description: "Opaque cursor for loading older messages" })
              .refine(
                (value) => {
                  if (!value) return true
                  try {
                    MessageV2.cursor.decode(value)
                    return true
                  } catch {
                    return false
                  }
                },
                { message: "Invalid cursor" },
              ),
          })
          .refine((value) => !value.before || value.limit !== undefined, {
            message: "before requires limit",
            path: ["before"],
          }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        if (query.limit === undefined) {
          await Session.get(sessionID)
          const messages = await Session.messages({ sessionID })
          return c.json(messages.map(view))
        }

        if (query.limit === 0) {
          await Session.get(sessionID)
          const messages = await Session.messages({ sessionID })
          return c.json(messages)
        }

        const page = await MessageV2.page({
          sessionID,
          limit: query.limit,
          before: query.before,
        })
        if (page.cursor) {
          const url = new URL(c.req.url)
          url.searchParams.set("limit", query.limit.toString())
          url.searchParams.set("before", page.cursor)
          c.header("Access-Control-Expose-Headers", "Link, X-Next-Cursor")
          c.header("Link", `<${url.toString()}>; rel=\"next\"`)
          c.header("X-Next-Cursor", page.cursor)
        }
        return c.json(page.items.map(view))
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info,
                    parts: MessageV2.Part.array(),
                  }),
                ),
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
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(view(message))
      },
    )
    .delete(
      "/:sessionID/message/:messageID/queued",
      describeRoute({
        summary: "Cancel queued message",
        description: "Delete a queued user message from a session without stopping the current running turn.",
        operationId: "session.cancelQueuedMessage",
        responses: {
          200: {
            description: "Successfully cancelled queued message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await SessionPrompt.cancelQueuedMessage({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(true)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
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
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        SessionPrompt.assertNotBusy(params.sessionID)
        await Session.removeMessage({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(true)
      },
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
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
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.removePart({
          sessionID: params.sessionID,
          messageID: params.messageID,
          partID: params.partID,
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part),
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
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      validator("json", MessageV2.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        const part = await Session.updatePart(body)
        return c.json(part)
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const msg = await SessionPrompt.prompt({ ...body, metadata: external(body.metadata), sessionID })
          stream.write(JSON.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const session = await Session.get(sessionID)
        if (
          !SessionPrompt.busy(sessionID) &&
          body.model &&
          (session.model?.providerID !== body.model.providerID || session.model.modelID !== body.model.modelID)
        ) {
          await Session.setModel({ sessionID, model: body.model, confirm: body.confirm })
        }
        const msg = await SessionPrompt.enqueue({ ...body, metadata: external(body.metadata), sessionID })
        if (body.noReply !== true) {
          void SessionPrompt.loop({ sessionID, messageID: msg.info.id }).catch((err) => {
            log.warn("async session prompt failed", { sessionID, err })
            SessionStatus.set(sessionID, { type: "error", message: err instanceof Error ? err.message : String(err) })
          })
        }
        return c.body(null, 204)
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.command({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Assistant),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.shell({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        const session = await SessionRevert.revert({
          sessionID,
          ...c.req.valid("json"),
        })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        const sessionID = c.req.valid("param").sessionID
        const session = await SessionRevert.unrevert({ sessionID })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
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
          sessionID: SessionID.zod,
          permissionID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ response: PermissionNext.Reply })),
      async (c) => {
        const params = c.req.valid("param")
        const result = await PermissionNext.reply({
          requestID: params.permissionID,
          sessionID: params.sessionID,
          reply: c.req.valid("json").response,
        })
        if (result.type === "not_found")
          throw new NotFoundError({ message: `Permission request not found: ${params.permissionID}` })
        if (result.type === "forbidden") {
          throw new ForbiddenError({
            message: `Permission request does not belong to the current session or workspace`,
          })
        }
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/runs",
      describeRoute({
        summary: "List session protocol runs",
        description: "List persisted Agent Protocol runs and planning documents for one session.",
        operationId: "session.runs",
        responses: {
          200: {
            description: "Session protocol runs",
            content: { "application/json": { schema: resolver(SessionRuns.Run.array()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.get(sessionID)
        return c.json(await SessionRuns.list(sessionID))
      },
    )
    .get(
      "/:sessionID/runs/:runID",
      describeRoute({
        summary: "Get session protocol run",
        description: "Get one persisted Agent Protocol run with its task content and planning documents.",
        operationId: "session.run",
        responses: {
          200: {
            description: "Session protocol run",
            content: { "application/json": { schema: resolver(SessionRuns.Run) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod, runID: SessionRuns.ID })),
      async (c) => {
        const input = c.req.valid("param")
        await Session.get(input.sessionID)
        const run = await SessionRuns.get(input.sessionID, input.runID)
        if (!run) return c.json({ message: `Run not found: ${input.runID}` }, 404)
        return c.json(run)
      },
    )
    .get(
      "/:sessionID/runs/:runID/documents",
      describeRoute({
        summary: "List session run documents",
        description: "List Markdown planning documents stored for one session protocol run.",
        operationId: "session.run.documents",
        responses: {
          200: {
            description: "Session run documents",
            content: { "application/json": { schema: resolver(SessionRuns.Document.array()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod, runID: SessionRuns.ID })),
      async (c) => {
        const input = c.req.valid("param")
        await Session.get(input.sessionID)
        const run = await SessionRuns.get(input.sessionID, input.runID)
        if (!run) return c.json({ message: `Run not found: ${input.runID}` }, 404)
        return c.json(run.documents)
      },
    )
    .get(
      "/:sessionID/runs/:runID/document",
      describeRoute({
        summary: "Read session run document",
        description: "Read one Markdown planning document within the current session and run boundary.",
        operationId: "session.run.document",
        responses: {
          200: {
            description: "Session run document",
            content: { "application/json": { schema: resolver(SessionRuns.Content) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod, runID: SessionRuns.ID })),
      validator("query", z.object({ path: z.string().min(1) })),
      async (c) => {
        const input = c.req.valid("param")
        await Session.get(input.sessionID)
        if (!(await SessionRuns.get(input.sessionID, input.runID)))
          return c.json({ message: `Run not found: ${input.runID}` }, 404)
        const document = await SessionRuns.read(input.sessionID, input.runID, c.req.valid("query").path)
        if (!document) return c.json({ message: "Document not found" }, 404)
        return c.json(document)
      },
    )
    .get(
      "/:sessionID/checkpoints",
      describeRoute({
        summary: "List session checkpoints",
        description: "Get all checkpoint hashes and timestamps for a session.",
        operationId: "session.checkpoints",
        responses: {
          200: {
            description: "List of checkpoints",
            content: {
              "application/json": {
                schema: resolver(SessionTimeline.Checkpoint.array()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.get(sessionID)
        const checkpoints = await SessionTimeline.list(sessionID)
        return c.json(checkpoints)
      },
    )
    .post(
      "/:sessionID/restore",
      describeRoute({
        summary: "Restore session from checkpoint",
        description: "Restore workspace files to the state at a checkpoint hash.",
        operationId: "session.restore",
        responses: {
          200: {
            description: "Restored session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          hash: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const { hash } = c.req.valid("json")
        const session = await SessionTimeline.restore(sessionID, hash)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/restore/preview",
      describeRoute({
        summary: "Preview session checkpoint restore",
        description: "Preview workspace file changes for a checkpoint restore without mutating files or session state.",
        operationId: "session.restorePreview",
        responses: {
          200: {
            description: "Restore preview",
            content: {
              "application/json": {
                schema: resolver(SessionTimeline.Preview),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          hash: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        return c.json(await SessionTimeline.preview(sessionID, body.hash))
      },
    )
    .patch(
      "/:sessionID/dsl_context",
      describeRoute({
        summary: "Update session dsl_context",
        description: "Update the workflow DSL context for a session.",
        operationId: "session.setDslContext",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          dsl_context: Session.Info.shape.dsl_context,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const { dsl_context } = c.req.valid("json")
        const session = await Session.setDslContext({ sessionID, dsl_context })
        return c.json(session)
      },
    ),
)
