import { runPromiseInstance } from "@/effect/runtime"
import { Config } from "@/config/config"
import { fn } from "@/util/fn"
import z from "zod"
import { PermissionInherit } from "./inherit"
import { Policy } from "./policy"
import * as S from "./service"

export namespace PermissionNext {
  export const Action = S.Action
  export type Action = S.Action
  export const Rule = S.Rule
  export type Rule = S.Rule
  export const Ruleset = S.Ruleset
  export type Ruleset = S.Ruleset
  export const Request = S.Request
  export type Request = S.Request
  export const Trace = S.Trace
  export type Trace = S.Trace
  export const Reply = S.Reply
  export type Reply = S.Reply
  export const ReplyResult = S.ReplyResult
  export type ReplyResult = S.ReplyResult
  export const Event = S.Event
  export const Service = S.PermissionService
  export const RejectedError = S.RejectedError
  export const CorrectedError = S.CorrectedError
  export const DeniedError = S.DeniedError
  export const PolicyModel = Policy.Model
  export type PolicyModel = Policy.Model
  export const Inherit = PermissionInherit

  export function fromConfig(permission: Config.Permission) {
    return Policy.toLegacy(Policy.fromConfig(permission))
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return Policy.toLegacy(Policy.merge(...rulesets.map((ruleset) => Policy.fromLegacy(ruleset))))
  }

  export const ask = fn(S.AskInput, async (input) =>
    runPromiseInstance(S.PermissionService.use((service) => service.ask(input))),
  )

  export const reply = fn(S.ReplyInput, async (input) =>
    runPromiseInstance(S.PermissionService.use((service) => service.reply(input))),
  )

  export async function list(input?: z.infer<typeof S.ListInput>) {
    return runPromiseInstance(S.PermissionService.use((service) => service.list(input)))
  }

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    return S.evaluate(permission, pattern, ...rulesets)
  }

  export function trace(permission: string, pattern: string, ...rulesets: Ruleset[]) {
    return Policy.evaluate(Policy.merge(...rulesets.map((ruleset) => Policy.fromLegacy(ruleset))), permission, pattern)
  }

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    return Policy.disabled(tools, Policy.fromLegacy(ruleset))
  }
}
