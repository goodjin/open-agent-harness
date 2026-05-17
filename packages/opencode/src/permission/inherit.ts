import { Policy } from "./policy"

export namespace PermissionInherit {
  export type Layer = {
    source: Policy.Source
    policy: Policy.Model
  }

  const ORDER: Policy.Source[] = ["user", "project", "session", "agent", "tool"]

  export function calculate(layers: readonly Layer[], opts: { deny?: boolean } = {}): Policy.Model {
    const rules = ORDER.flatMap((source) =>
      layers
        .filter((layer) => layer.source === source)
        .flatMap((layer) =>
          layer.policy.rules.map((rule) => ({
            ...rule,
            source,
          })),
        ),
    )
    if (opts.deny === false) return { rules }
    return {
      rules: [...rules.filter((rule) => rule.action !== "deny"), ...rules.filter((rule) => rule.action === "deny")],
    }
  }
}
