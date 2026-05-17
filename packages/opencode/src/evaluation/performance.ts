import z from "zod"

export namespace Performance {
  export const Target = z
    .enum(["agent_loader_ms", "session_create_ms", "permission_eval_ms"])
    .meta({
      ref: "PerformanceTarget",
    })
  export type Target = z.infer<typeof Target>

  export const Threshold = z
    .object({
      target: Target,
      limit: z.number(),
      description: z.string(),
    })
    .meta({
      ref: "PerformanceThreshold",
    })
  export type Threshold = z.infer<typeof Threshold>

  export const thresholds = [
    {
      target: "agent_loader_ms",
      limit: 250,
      description: "Load package and project agent templates in a warm local workspace.",
    },
    {
      target: "session_create_ms",
      limit: 150,
      description: "Create a session in an initialized project workspace.",
    },
    {
      target: "permission_eval_ms",
      limit: 25,
      description: "Evaluate one permission decision against a small ruleset.",
    },
  ] satisfies Threshold[]

  export function check(target: Target, duration: number) {
    const threshold = thresholds.find((item) => item.target === target)
    if (!threshold) throw new Error(`Unknown performance target: ${target}`)
    return {
      target,
      duration,
      limit: threshold.limit,
      ok: duration <= threshold.limit,
    }
  }
}
