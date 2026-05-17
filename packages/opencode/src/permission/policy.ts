import os from "os"
import z from "zod"
import { Capability } from "./capability"
import { SixDim } from "./six-dim"

export namespace Policy {
  export const Action = z.enum(["allow", "deny", "ask"])
  export type Action = z.infer<typeof Action>

  export const Source = z.enum(["user", "project", "session", "agent", "tool", "legacy", "default"])
  export type Source = z.infer<typeof Source>

  export const Rule = z
    .object({
      dimension: Capability.Dimension.optional(),
      permission: z.string().min(1),
      pattern: z.string().min(1).default("*"),
      action: Action,
      source: Source.default("legacy"),
      note: z.string().optional(),
    })
    .strict()
  export type Rule = z.infer<typeof Rule>

  export const Model = z
    .object({
      rules: z.array(Rule),
    })
    .strict()
  export type Model = z.infer<typeof Model>

  export type Legacy = Pick<Rule, "permission" | "pattern" | "action">
  export type Template = {
    inherit: boolean
    policy: "inherit" | "allow" | "custom"
    allowed_tools: string[]
    denied_tools: string[]
  }

  export type Decision = {
    action: Action
    capability: Capability.Item
    rule: Rule
    index: number
    matched: Rule[]
  }

  const EDIT = new Set(["edit", "write", "patch", "multiedit"])

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  function rule(tool: string, action: Action, source: Source): Rule {
    const permission = EDIT.has(tool) ? "edit" : tool
    return {
      permission,
      pattern: "*",
      action,
      source,
    }
  }

  function item(permission: string, pattern: string) {
    if (permission === "*") return { permission, pattern }
    return Capability.make(permission, pattern)
  }

  export function parse(input: unknown): Model {
    return Model.parse(input)
  }

  export function fromConfig(input: Record<string, Action | Record<string, Action>>, source: Source = "user"): Model {
    return {
      rules: Object.entries(input).flatMap(([permission, value]) => {
        if (typeof value === "string") return [{ ...item(permission, "*"), action: value, source }]
        return Object.entries(value).map(([pattern, action]) => ({
          ...item(permission, expand(pattern)),
          action,
          source,
        }))
      }),
    }
  }

  export function fromLegacy(rules: readonly Legacy[], source: Source = "legacy"): Model {
    return {
      rules: rules.map((legacy) => ({
        ...item(legacy.permission, legacy.pattern),
        action: legacy.action,
        source,
      })),
    }
  }

  export function toLegacy(policy: Model): Legacy[] {
    return policy.rules.map((rule) => ({
      permission: rule.permission,
      pattern: rule.pattern,
      action: rule.action,
    }))
  }

  export function fromTemplate(input: Template, source: Source = "agent"): Model {
    const base = input.policy === "allow" ? [rule("*", "allow", source)] : []
    const fallback = input.policy === "custom" ? [rule("*", "deny", source)] : base
    return {
      rules: [
        ...fallback,
        ...input.allowed_tools.map((tool) => rule(tool, "allow", source)),
        ...input.denied_tools.map((tool) => rule(tool, "deny", source)),
      ],
    }
  }

  export function merge(...policies: Model[]): Model {
    return {
      rules: policies.flatMap((policy) => policy.rules),
    }
  }

  export function decide(policy: Model, cap: Capability.Item): Decision {
    const matched = policy.rules.filter((rule) => SixDim.matches(rule, cap))
    const rule = matched.at(-1) ?? {
      permission: cap.permission,
      pattern: "*",
      action: "ask" as const,
      source: "default" as const,
    }
    return {
      action: rule.action,
      capability: cap,
      rule,
      index: rule.source === "default" ? -1 : policy.rules.lastIndexOf(rule),
      matched,
    }
  }

  export function evaluate(policy: Model, permission: string, pattern: string): Decision {
    return decide(policy, Capability.make(permission, pattern))
  }

  export function disabled(tools: string[], policy: Model): Set<string> {
    return new Set(
      tools.filter((tool) => {
        const item = policy.rules.findLast((rule) => {
          const match = SixDim.match(rule, Capability.make(tool))
          return match.dimension && match.permission
        })
        return item?.pattern === "*" && item.action === "deny"
      }),
    )
  }
}
