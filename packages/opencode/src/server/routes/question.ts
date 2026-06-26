import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Bus } from "@/bus"
import { QuestionID } from "@/question/schema"
import { Question } from "../../question"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { SessionAssignment } from "@/session/assignment"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

type Confirm = {
  action_id?: unknown
  action_title?: unknown
  assignment?: unknown
  message_id?: unknown
  plan?: unknown
  plan_ref?: unknown
  run_id?: unknown
  status?: unknown
  updated_at?: unknown
}

const prefix = "que_protocol_confirm_"
const iprefix = "que_protocol_input_"
const log = Log.create({ service: "server.question" })

const text = (input: unknown) => (typeof input === "string" ? input : undefined)
const num = (input: unknown) => (typeof input === "number" ? input : 0)
const rec = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

function id(input: { sessionID: string; run: string; action: string }) {
  return QuestionID.make(`${prefix}${Buffer.from(JSON.stringify(input)).toString("base64url")}`)
}

function iid(input: { sessionID: string; run: string; action: string }) {
  return QuestionID.make(`${iprefix}${Buffer.from(JSON.stringify(input)).toString("base64url")}`)
}

function parse(input: QuestionID) {
  const raw = String(input)
  if (!raw.startsWith(prefix)) return
  try {
    const data = JSON.parse(Buffer.from(raw.slice(prefix.length), "base64url").toString("utf8"))
    if (!rec(data)) return
    const sessionID = text(data.sessionID)
    const run = text(data.run)
    const action = text(data.action)
    if (!sessionID || !run || !action) return
    return { sessionID: SessionID.make(sessionID), run, action }
  } catch {
    return
  }
}

function iparse(input: QuestionID) {
  const raw = String(input)
  if (!raw.startsWith(iprefix)) return
  try {
    const data = JSON.parse(Buffer.from(raw.slice(iprefix.length), "base64url").toString("utf8"))
    if (!rec(data)) return
    const sessionID = text(data.sessionID)
    const run = text(data.run)
    const action = text(data.action)
    if (!sessionID || !run || !action) return
    return { sessionID: SessionID.make(sessionID), run, action }
  } catch {
    return
  }
}

function pending(sessions: Session.Info[]) {
  const latest = new Map<string, Confirm>()
  for (const session of sessions) {
    const protocol = rec(session.dsl_context?.protocol) ? session.dsl_context.protocol : undefined
    const vals = Array.isArray(protocol?.confirmations) ? protocol.confirmations : []
    for (const val of vals) {
      if (!rec(val) || val.status !== "pending") continue
      if (!text(val.run_id) || !text(val.action_id) || !text(val.message_id)) continue
      const prev = latest.get(session.id)
      if (prev && num(prev.updated_at) >= num(val.updated_at)) continue
      latest.set(session.id, val)
    }
  }
  return Array.from(latest.entries())
}

function questions(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    if (!rec(item)) return []
    const question = text(item.question)
    const header = text(item.header)
    if (!question || !header) return []
    const options = Array.isArray(item.options)
      ? item.options.flatMap((opt) => {
          if (!rec(opt)) return []
          const label = text(opt.label)
          if (!label) return []
          return [{ label, description: text(opt.description) ?? label }]
        })
      : []
    return [
      {
        question,
        header,
        options,
        multiple: item.multiple === true,
        custom: typeof item.custom === "boolean" ? item.custom : undefined,
      },
    ]
  })
}

function inputs(sessions: Session.Info[]) {
  const latest = new Map<string, Record<string, unknown>>()
  for (const session of sessions) {
    const protocol = rec(session.dsl_context?.protocol) ? session.dsl_context.protocol : undefined
    const vals = Array.isArray(protocol?.inputs) ? protocol.inputs : []
    for (const val of vals) {
      if (!rec(val) || val.status !== "pending") continue
      if (!text(val.run_id) || !text(val.action_id) || !text(val.message_id)) continue
      if (questions(val.questions).length === 0) continue
      const key = `${session.id}:${val.run_id}:${val.action_id}`
      const prev = latest.get(key)
      if (prev && num(prev.updated_at) >= num(val.updated_at)) continue
      latest.set(key, { ...val, session_id: session.id })
    }
  }
  return Array.from(latest.values())
}

function resume(input: Parameters<typeof SessionPrompt.prompt>[0]) {
  void SessionPrompt.prompt(input).catch((err) => {
    log.warn("failed to continue restored protocol question", { sessionID: input.sessionID, err })
  })
}

async function confirm(input: {
  answers?: Question.Answer[]
  reject?: boolean
  requestID: QuestionID
  response?: Question.Reply["response"]
}) {
  const key = parse(input.requestID)
  if (!key) return false
  const status = input.reject || input.response === "cancel" ? "cancelled" : "confirmed"
  const session = await Session.get(key.sessionID)
  const ctx = rec(session.dsl_context) ? session.dsl_context : {}
  const protocol = rec(ctx.protocol) ? ctx.protocol : {}
  const vals = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
  const next = vals.map((val) => {
    if (!rec(val)) return val
    if (val.run_id !== key.run || val.action_id !== key.action) return val
    return {
      ...val,
      response: status === "confirmed" ? "confirm" : "cancel",
      status,
      updated_at: Date.now(),
    }
  })
  const item = next.find((val) => rec(val) && val.run_id === key.run && val.action_id === key.action)
  if (rec(item)) {
    if (status === "confirmed") {
      const msg = text(item.message_id)
      const run = text(item.run_id)
      const action = text(item.action_id)
      const plan = text(item.plan)
      const title = text(item.action_title) ?? action
      if (msg && run && action && plan && title) {
        const assignment = await SessionAssignment.apply({
          actionID: action,
          assignment: item.assignment,
          messageID: MessageID.make(msg),
          plan,
          runID: run,
          sessionID: key.sessionID,
          title,
        })
        if (assignment) {
          item.assignment = {
            id: assignment.id,
            session_id: assignment.session_id,
            status: assignment.status,
            content_ref: assignment.content_ref,
            content_version: assignment.content_version,
          }
        }
      }
    }
    await Storage.write(["session_protocol_confirmation", key.sessionID, key.run, key.action], item)
  }
  await Session.setDslContext({
    sessionID: key.sessionID,
    dsl_context: {
      ...ctx,
      protocol: {
        ...protocol,
        confirmations: next,
      },
    },
  })
  if (input.reject) {
    await Bus.publish(Question.Event.Rejected, {
      sessionID: key.sessionID,
      requestID: input.requestID,
    })
  } else {
    await Bus.publish(Question.Event.Replied, {
      sessionID: key.sessionID,
      requestID: input.requestID,
      answers: input.answers ?? [],
      response: input.response,
    })
  }
  resume({
    sessionID: key.sessionID,
    parts: [
      {
        type: "text",
        text:
          status === "confirmed"
            ? `User confirmed protocol action ${key.action} from run ${key.run}. Continue from the current protocol state without re-asking this confirmation.`
            : `User cancelled protocol action ${key.action} from run ${key.run}. Do not execute downstream work that depended on that confirmation.`,
      },
    ],
  })
  return true
}

async function answer(input: {
  answers?: Question.Answer[]
  reject?: boolean
  requestID: QuestionID
}) {
  const key = iparse(input.requestID)
  if (!key) return false
  const session = await Session.get(key.sessionID)
  const ctx = rec(session.dsl_context) ? session.dsl_context : {}
  const protocol = rec(ctx.protocol) ? ctx.protocol : {}
  const vals = Array.isArray(protocol.inputs) ? protocol.inputs : []
  const status = input.reject ? "rejected" : "answered"
  const next = vals.map((val) => {
    if (!rec(val)) return val
    if (val.run_id !== key.run || val.action_id !== key.action) return val
    return {
      ...val,
      answers: input.answers,
      status,
      updated_at: Date.now(),
    }
  })
  const item = next.find((val) => rec(val) && val.run_id === key.run && val.action_id === key.action)
  await Session.setDslContext({
    sessionID: key.sessionID,
    dsl_context: {
      ...ctx,
      protocol: {
        ...protocol,
        inputs: next,
      },
    },
  })
  if (rec(item)) {
    await Storage.write(["session_protocol_input", key.sessionID, key.run, key.action], item)
  }
  const qs = rec(item) ? questions(item.questions) : []
  const lines = (input.answers ?? []).flatMap((ans, idx) => {
    const q = qs[idx]
    const label = q?.header ?? `question_${idx + 1}`
    if (ans.length === 0) return [`- ${label}: no answer`]
    return [`- ${label}: ${ans.map((part) => `"${part}"`).join(", ")}`]
  })
  if (input.reject) {
    await Bus.publish(Question.Event.Rejected, {
      sessionID: key.sessionID,
      requestID: input.requestID,
    })
  } else {
    await Bus.publish(Question.Event.Replied, {
      sessionID: key.sessionID,
      requestID: input.requestID,
      answers: input.answers ?? [],
    })
  }
  resume({
    sessionID: key.sessionID,
    parts: [
      {
        type: "text",
        text: input.reject
          ? `User dismissed protocol input ${key.action} from run ${key.run}. Continue from the current protocol state without re-asking the same question unless a different answer is required.`
          : [
              `User answered protocol input ${key.action} from run ${key.run}.`,
              "Use this captured answer and continue from the current protocol state without re-asking the same question:",
              ...lines,
            ].join("\n"),
      },
    ],
  })
  return true
}

export const QuestionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending questions",
        description: "Get all pending question requests across all sessions.",
        operationId: "question.list",
        responses: {
          200: {
            description: "List of pending questions",
            content: {
              "application/json": {
                schema: resolver(Question.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const sessions = Array.from(Session.list({ limit: 5000 }))
        const ids = new Set(sessions.map((session) => session.id))
        const live = (await Question.list()).filter((item) => ids.has(item.sessionID))
        const seen = new Set(live.map((item) => `${item.sessionID}:${item.tool?.messageID}:${item.tool?.callID}`))
        const restored = pending(sessions).flatMap(([sessionID, item]) => {
          const run = text(item.run_id)
          const action = text(item.action_id)
          const message = text(item.message_id)
          if (!run || !action || !message) return []
          const call = `call_${action}`
          if (seen.has(`${sessionID}:${message}:${call}`)) return []
          const plan = text(item.plan) ?? ""
          return [
            {
              id: id({ sessionID, run, action }),
              sessionID: SessionID.make(sessionID),
              questions: [
                {
                  question: ["Please confirm this plan before execution.", "", plan]
                    .filter((part) => part.trim().length > 0)
                    .join("\n"),
                  header: "Confirm plan",
                  options: [
                    { label: "Confirm", description: "Approve this plan and continue execution." },
                    { label: "Cancel", description: "Do not execute this plan." },
                  ],
                  multiple: false,
                  custom: false,
                },
              ],
              tool: { messageID: MessageID.make(message), callID: call },
            },
          ]
        })
        const restoredInputs = inputs(sessions).flatMap((item) => {
          const sessionID = text(item.session_id)
          const run = text(item.run_id)
          const action = text(item.action_id)
          const message = text(item.message_id)
          if (!sessionID || !run || !action || !message) return []
          const call = `call_${action}`
          if (seen.has(`${sessionID}:${message}:${call}`)) return []
          return [
            {
              id: iid({ sessionID, run, action }),
              sessionID: SessionID.make(sessionID),
              questions: questions(item.questions),
              tool: { messageID: MessageID.make(message), callID: call },
            },
          ]
        })
        const list = [...live, ...restored, ...restoredInputs]
        return c.json(list)
      },
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to question request",
        description: "Provide answers to a question request from the AI assistant.",
        operationId: "question.reply",
        responses: {
          200: {
            description: "Question answered successfully",
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
          requestID: QuestionID.zod,
        }),
      ),
      validator("json", Question.Reply),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        if (await answer({ requestID: params.requestID, answers: json.answers })) {
          return c.json(true)
        }
        if (await confirm({ requestID: params.requestID, answers: json.answers, response: json.response })) {
          return c.json(true)
        }
        await Question.reply({
          requestID: params.requestID,
          answers: json.answers,
          response: json.response,
        })
        return c.json(true)
      },
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject question request",
        description: "Reject a question request from the AI assistant.",
        operationId: "question.reject",
        responses: {
          200: {
            description: "Question rejected successfully",
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
          requestID: QuestionID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        if (await answer({ requestID: params.requestID, reject: true })) return c.json(true)
        if (await confirm({ requestID: params.requestID, reject: true })) return c.json(true)
        await Question.reject(params.requestID)
        return c.json(true)
      },
    ),
)
