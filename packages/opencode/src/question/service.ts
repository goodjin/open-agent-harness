import { Deferred, Effect, Layer, Schema, ServiceMap } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"
import z from "zod"
import { QuestionID } from "./schema"

const log = Log.create({ service: "question" })

// --- Zod schemas (re-exported by facade) ---

export const Option = z
  .object({
    label: z.string().describe("Display text (1-5 words, concise)"),
    description: z.string().describe("Explanation of choice"),
  })
  .meta({ ref: "QuestionOption" })
export type Option = z.infer<typeof Option>

export const Info = z
  .object({
    question: z.string().describe("Complete question"),
    header: z.string().describe("Very short label (max 30 chars)"),
    options: z.array(Option).describe("Available choices"),
    multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
    custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
  })
  .meta({ ref: "QuestionInfo" })
export type Info = z.infer<typeof Info>

export const Request = z
  .object({
    id: QuestionID.zod,
    sessionID: SessionID.zod,
    questions: z.array(Info).describe("Questions to ask"),
    tool: z
      .object({
        messageID: MessageID.zod,
        callID: z.string(),
      })
      .optional(),
  })
  .meta({ ref: "QuestionRequest" })
export type Request = z.infer<typeof Request>

export const Answer = z.array(z.string()).describe("Selected answers. A selected option may include user-entered details as `label: details`.").meta({ ref: "QuestionAnswer" })
export type Answer = z.infer<typeof Answer>

export const Reply = z.object({
  answers: z.array(Answer).describe("User answers in order of questions (each answer is an array of selected labels, optionally with per-option details)"),
  response: z.enum(["confirm", "cancel"]).optional().describe("Explicit confirmation response for confirm-only prompts"),
})
export type Reply = z.infer<typeof Reply>

export const Event = {
  Asked: BusEvent.define("question.asked", Request),
  Replied: BusEvent.define(
    "question.replied",
    z.object({
      sessionID: SessionID.zod,
      requestID: QuestionID.zod,
      answers: z.array(Answer),
      response: Reply.shape.response,
    }),
  ),
  Rejected: BusEvent.define(
    "question.rejected",
    z.object({
      sessionID: SessionID.zod,
      requestID: QuestionID.zod,
    }),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

// --- Effect service ---

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<Reply, RejectedError>
}

export namespace QuestionService {
  export interface Service {
    readonly ask: (input: {
      sessionID: SessionID
      questions: Info[]
      tool?: { messageID: MessageID; callID: string }
    }) => Effect.Effect<Answer[], RejectedError>
    readonly askReply: (input: {
      sessionID: SessionID
      questions: Info[]
      tool?: { messageID: MessageID; callID: string }
    }) => Effect.Effect<Reply, RejectedError>
    readonly reply: (input: { requestID: QuestionID; answers: Answer[]; response?: Reply["response"] }) => Effect.Effect<void>
    readonly reject: (requestID: QuestionID) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
  }
}

export class QuestionService extends ServiceMap.Service<QuestionService, QuestionService.Service>()(
  "@opencode/Question",
) {
  static readonly layer = Layer.effect(
    QuestionService,
    Effect.gen(function* () {
      const pending = new Map<QuestionID, PendingEntry>()
      const status = new Map<string, SessionStatus.Info>()

      function restore(sessionID: SessionID) {
        if (Array.from(pending.values()).some((item) => item.info.sessionID === sessionID)) return
        const current = SessionStatus.get(sessionID)
        if (current.type !== "waiting_user") return
        const prior = status.get(sessionID) ?? { type: "idle" }
        status.delete(sessionID)
        SessionStatus.set(sessionID, prior)
      }

      const askReply = Effect.fn("QuestionService.askReply")(function* (input: {
        sessionID: SessionID
        questions: Info[]
        tool?: { messageID: MessageID; callID: string }
      }) {
        const id = QuestionID.ascending()
        log.info("asking", { id, questions: input.questions.length })

        const deferred = yield* Deferred.make<Reply, RejectedError>()
        const info: Request = {
          id,
          sessionID: input.sessionID,
          questions: input.questions,
          tool: input.tool,
        }
        pending.set(id, { info, deferred })
        const current = SessionStatus.get(input.sessionID)
        if (current.type !== "waiting_user") {
          // Treat terminal states (timeout/error) as idle so the session can recover
          // once the user replies. Otherwise the prior would be restored on reply and
          // every follow-up ask would re-enter the same terminal state.
          const prior =
            current.type === "timeout" || current.type === "error" ? { type: "idle" as const } : current
          status.set(input.sessionID, prior)
        }
        SessionStatus.set(input.sessionID, { type: "waiting_user" })
        Bus.publish(Event.Asked, info)

        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            pending.delete(id)
            restore(input.sessionID)
          }),
        )
      })

      const ask = Effect.fn("QuestionService.ask")(function* (input: {
        sessionID: SessionID
        questions: Info[]
        tool?: { messageID: MessageID; callID: string }
      }) {
        return (yield* askReply(input)).answers
      })

      const reply = Effect.fn("QuestionService.reply")(function* (input: {
        requestID: QuestionID
        answers: Answer[]
        response?: Reply["response"]
      }) {
        const existing = pending.get(input.requestID)
        if (!existing) {
          log.warn("reply for unknown request", { requestID: input.requestID })
          return
        }
        pending.delete(input.requestID)
        log.info("replied", { requestID: input.requestID, answers: input.answers, response: input.response })
        Bus.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          answers: input.answers,
          response: input.response,
        })
        yield* Deferred.succeed(existing.deferred, { answers: input.answers, response: input.response })
      })

      const reject = Effect.fn("QuestionService.reject")(function* (requestID: QuestionID) {
        const existing = pending.get(requestID)
        if (!existing) {
          log.warn("reject for unknown request", { requestID })
          return
        }
        pending.delete(requestID)
        log.info("rejected", { requestID })
        Bus.publish(Event.Rejected, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
        })
        yield* Deferred.fail(existing.deferred, new RejectedError())
      })

      const list = Effect.fn("QuestionService.list")(function* () {
        return Array.from(pending.values(), (x) => x.info)
      })

      return QuestionService.of({ ask, askReply, reply, reject, list })
    }),
  )
}
