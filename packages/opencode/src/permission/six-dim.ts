import { Wildcard } from "@/util/wildcard"
import { Capability } from "./capability"

export namespace SixDim {
  export type Match = {
    dimension: boolean
    permission: boolean
    pattern: boolean
  }

  export function match(
    rule: Pick<Capability.Item, "permission" | "pattern"> & { dimension?: Capability.Dimension },
    cap: Capability.Item,
  ): Match {
    const dim = rule.dimension ?? (rule.permission === "*" ? undefined : Capability.dimension(rule.permission))
    return {
      dimension: dim === undefined || dim === cap.dimension,
      permission: Wildcard.match(cap.permission, Capability.normalize(rule.permission)),
      pattern: Wildcard.match(cap.pattern, rule.pattern),
    }
  }

  export function matches(
    rule: Pick<Capability.Item, "permission" | "pattern"> & { dimension?: Capability.Dimension },
    cap: Capability.Item,
  ) {
    const item = match(rule, cap)
    return item.dimension && item.permission && item.pattern
  }
}
