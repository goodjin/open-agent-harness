import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { WorkspaceID } from "@/control-plane/schema"
import { Instance } from "@/project/instance"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"
import { Audit } from "@/observability/audit"
import { Metrics } from "@/observability/metrics"
import { Wildcard } from "@/util/wildcard"
import { Deferred, Effect, Layer, Schema, ServiceMap } from "effect"
import z from "zod"
import { Policy } from "./policy"
import { PermissionID } from "./schema"

const log = Log.create({ service: "permission" })

export const Action = z.enum(["allow", "deny", "ask"]).meta({
  ref: "PermissionAction",
})
export type Action = z.infer<typeof Action>

export const Rule = z
  .object({
    permission: z.string(),
    pattern: z.string(),
    action: Action,
  })
  .meta({
    ref: "PermissionRule",
  })
export type Rule = z.infer<typeof Rule>

export const Ruleset = Rule.array().meta({
  ref: "PermissionRuleset",
})
export type Ruleset = z.infer<typeof Ruleset>

const TraceRule = Policy.Rule.pick({
  dimension: true,
  permission: true,
  pattern: true,
  action: true,
  source: true,
})

export const Trace = z
  .object({
    action: Policy.Action,
    pattern: z.string(),
    rule: TraceRule,
    index: z.number(),
    matched: TraceRule.array(),
  })
  .meta({
    ref: "PermissionTrace",
  })
export type Trace = z.infer<typeof Trace>

export const Request = z
  .object({
    id: PermissionID.zod,
    sessionID: SessionID.zod,
    workspaceID: WorkspaceID.zod.optional(),
    directory: z.string().optional(),
    permission: z.string(),
    patterns: z.string().array(),
    metadata: z.record(z.string(), z.any()),
    always: z.string().array(),
    trace: Trace.array().optional(),
    tool: z
      .object({
        messageID: MessageID.zod,
        callID: z.string(),
      })
      .optional(),
  })
  .meta({
    ref: "PermissionRequest",
  })
export type Request = z.infer<typeof Request>

export const Reply = z.enum(["once", "always", "reject"])
export type Reply = z.infer<typeof Reply>

export const Event = {
  Asked: BusEvent.define("permission.asked", Request),
  Replied: BusEvent.define(
    "permission.replied",
    z.object({
      sessionID: SessionID.zod,
      requestID: PermissionID.zod,
      reply: Reply,
      message: z.string().optional(),
    }),
  ),
  Audit: BusEvent.define(
    "permission.audit",
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("asked"),
        sessionID: SessionID.zod,
        workspaceID: WorkspaceID.zod.optional(),
        requestID: PermissionID.zod,
        permission: z.string(),
        ...Audit.PatternSummary.shape,
      }),
      z.object({
        type: z.literal("replied"),
        sessionID: SessionID.zod,
        workspaceID: WorkspaceID.zod.optional(),
        requestID: PermissionID.zod,
        reply: Reply,
        feedback: z.boolean(),
      }),
    ]),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export type PermissionError = DeniedError | RejectedError | CorrectedError

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

export const AskInput = Request.partial({ id: true }).extend({
  ruleset: Ruleset,
})

export const ReplyInput = z.object({
  requestID: PermissionID.zod,
  sessionID: SessionID.zod.optional(),
  reply: Reply,
  message: z.string().optional(),
})

export const ReplyResult = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("applied"),
  }),
  z.object({
    type: z.literal("not_found"),
  }),
  z.object({
    type: z.literal("forbidden"),
  }),
])
export type ReplyResult = z.infer<typeof ReplyResult>

export const ListInput = z
  .object({
    sessionID: SessionID.zod.optional(),
    all: z.boolean().optional(),
  })
  .optional()

export declare namespace PermissionService {
  export interface Api {
    readonly ask: (input: z.infer<typeof AskInput>) => Effect.Effect<void, PermissionError>
    readonly reply: (input: z.infer<typeof ReplyInput>) => Effect.Effect<ReplyResult>
    readonly list: (input?: z.infer<typeof ListInput>) => Effect.Effect<Request[]>
  }
}

export class PermissionService extends ServiceMap.Service<PermissionService, PermissionService.Api>()(
  "@opencode/PermissionNext",
) {
  static readonly layer = Layer.effect(
    PermissionService,
    Effect.gen(function* () {
      const pending = new Map<PermissionID, PendingEntry>()
      const status = new Map<string, SessionStatus.Info>()

      function key(sessionID: SessionID, dir: string) {
        return `${sessionID}:${dir}`
      }

      function scoped(item: Request, sessionID: SessionID, dir: string) {
        if (item.sessionID !== sessionID) return false
        return item.directory === dir
      }

      function visible(item: Request, input?: z.infer<typeof ListInput>) {
        if (!input?.all) {
          if (item.directory !== Instance.directory) return false
        }
        if (input?.sessionID && item.sessionID !== input.sessionID) return false
        return true
      }

      function restore(items: PendingEntry[]) {
        const item = items[0]
        if (!item) return
        const dir = item.info.directory ?? Instance.directory
        const id = key(item.info.sessionID, dir)
        if (Array.from(pending.values()).some((entry) => scoped(entry.info, item.info.sessionID, dir))) {
          SessionStatus.set(item.info.sessionID, { type: "waiting_permission" })
          return
        }
        const current = SessionStatus.get(item.info.sessionID)
        if (current.type !== "waiting_permission") return
        const prior = status.get(id) ?? { type: "idle" }
        status.delete(id)
        SessionStatus.set(item.info.sessionID, prior)
      }

      const ask = Effect.fn("PermissionService.ask")(function* (input: z.infer<typeof AskInput>) {
        const { ruleset, ...request } = input
        let needsAsk = false
        const trace: Trace[] = []

        for (const pattern of request.patterns) {
          const decision = decisionFor(request.permission, pattern, ruleset)
          trace.push({
            action: decision.action,
            pattern,
            rule: decision.rule,
            index: decision.index,
            matched: decision.matched,
          })
          log.info("evaluated", { permission: request.permission, pattern, action: decision.action })
          if (decision.action === "deny") {
            return yield* new DeniedError({
              ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            })
          }
          if (decision.action === "allow") continue
          needsAsk = true
        }

        if (!needsAsk) return

        const id = request.id ?? PermissionID.ascending()
        const info: Request = {
          id,
          ...request,
          directory: request.directory ?? Instance.directory,
          trace,
        }
        log.info("asking", { id, permission: info.permission, patterns: info.patterns })

        const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
        const current = SessionStatus.get(request.sessionID)
        if (current.type !== "waiting_permission") status.set(key(info.sessionID, info.directory ?? Instance.directory), current)
        SessionStatus.set(request.sessionID, { type: "waiting_permission" })
        pending.set(id, { info, deferred })
        void Bus.publish(Event.Asked, info)
        void Bus.publish(Event.Audit, {
          type: "asked",
          sessionID: info.sessionID,
          workspaceID: info.workspaceID,
          requestID: info.id,
          permission: info.permission,
          ...Audit.summarize(info.patterns),
        })
        void Audit.emit({
          sessionID: info.sessionID,
          workspaceID: info.workspaceID,
          event: {
            type: "permission.asked",
            requestID: String(info.id),
            permission: info.permission,
            patterns: info.patterns,
          },
        })
        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            pending.delete(id)
          }),
        )
      })

      const reply = Effect.fn("PermissionService.reply")(function* (input: z.infer<typeof ReplyInput>) {
        const existing = pending.get(input.requestID)
        if (!existing) return { type: "not_found" as const }
        const dir = existing.info.directory ?? Instance.directory
        if (dir !== Instance.directory) return { type: "forbidden" as const }
        if (input.sessionID && existing.info.sessionID !== input.sessionID) return { type: "forbidden" as const }

        pending.delete(input.requestID)
        const done = [existing]

        if (input.reply === "reject") {
          void Bus.publish(Event.Replied, {
            sessionID: existing.info.sessionID,
            requestID: existing.info.id,
            reply: "reject",
            message: input.message,
          })
          void Bus.publish(Event.Audit, {
            type: "replied",
            sessionID: existing.info.sessionID,
            workspaceID: existing.info.workspaceID,
            requestID: existing.info.id,
            reply: "reject",
            feedback: input.message !== undefined,
          })
          void Audit.emit({
            sessionID: existing.info.sessionID,
            workspaceID: existing.info.workspaceID,
            event: {
              type: "permission.replied",
              requestID: String(existing.info.id),
              reply: "reject",
              feedback: input.message !== undefined,
            },
          })
          yield* Deferred.fail(
            existing.deferred,
            input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
          )

          for (const [id, item] of pending.entries()) {
            if (!scoped(item.info, existing.info.sessionID, dir)) continue
            pending.delete(id)
            done.push(item)
            void Bus.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "reject",
            })
            void Bus.publish(Event.Audit, {
              type: "replied",
              sessionID: item.info.sessionID,
              workspaceID: item.info.workspaceID,
              requestID: item.info.id,
              reply: "reject",
              feedback: false,
            })
            void Audit.emit({
              sessionID: item.info.sessionID,
              workspaceID: item.info.workspaceID,
              event: {
                type: "permission.replied",
                requestID: String(item.info.id),
                reply: "reject",
              },
            })
            yield* Deferred.fail(item.deferred, new RejectedError())
          }
          restore(done)
          return { type: "applied" as const }
        }

        void Bus.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          reply: input.reply,
        })
        void Bus.publish(Event.Audit, {
          type: "replied",
          sessionID: existing.info.sessionID,
          workspaceID: existing.info.workspaceID,
          requestID: existing.info.id,
          reply: input.reply,
          feedback: false,
        })
        void Audit.emit({
          sessionID: existing.info.sessionID,
          workspaceID: existing.info.workspaceID,
          event: {
            type: "permission.replied",
            requestID: String(existing.info.id),
            reply: input.reply,
          },
        })
        yield* Deferred.succeed(existing.deferred, undefined)

        // When "always" is replied, resolve matching pending requests in same session
        if (input.reply === "always") {
          const alwaysRules: Ruleset = existing.info.always.map((pattern) => ({
            permission: existing.info.permission,
            pattern,
            action: "allow" as const,
          }))

          for (const [id, item] of pending.entries()) {
            if (!scoped(item.info, existing.info.sessionID, dir)) continue
            const ok = item.info.patterns.every(
              (pattern) => evaluate(item.info.permission, pattern, alwaysRules).action === "allow",
            )
            if (!ok) continue
            pending.delete(id)
            done.push(item)
            void Bus.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "always",
            })
            void Bus.publish(Event.Audit, {
              type: "replied",
              sessionID: item.info.sessionID,
              workspaceID: item.info.workspaceID,
              requestID: item.info.id,
              reply: "always",
              feedback: false,
            })
            void Audit.emit({
              sessionID: item.info.sessionID,
              workspaceID: item.info.workspaceID,
              event: {
                type: "permission.replied",
                requestID: String(item.info.id),
                reply: "always",
              },
            })
            yield* Deferred.succeed(item.deferred, undefined)
          }
        }
        restore(done)
        return { type: "applied" as const }
      })

      const list = Effect.fn("PermissionService.list")(function* (input?: z.infer<typeof ListInput>) {
        return Array.from(pending.values(), (item) => item.info).filter((item) => visible(item, input))
      })

      return PermissionService.of({ ask, reply, list })
    }),
  )
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  const trace = decisionFor(permission, pattern, ...rulesets)
  return {
    permission: trace.rule.permission,
    pattern: trace.rule.pattern,
    action: trace.action,
  }
}

function decisionFor(permission: string, pattern: string, ...rulesets: Ruleset[]) {
  const policy = Policy.merge(...rulesets.map((ruleset) => Policy.fromLegacy(ruleset)))
  const trace = Policy.evaluate(policy, permission, pattern)
  log.info("evaluate", { permission, pattern, rule: trace.rule, source: trace.rule.source, index: trace.index })
  Metrics.emit("opencode_permission_evaluation_total", {
    permission,
    action: trace.action,
    source: trace.rule.source,
  })
  return trace
}
