import z from "zod"

export namespace Metrics {
  export const Name = z
    .enum([
      "opencode_agent_load_total",
      "opencode_agent_load_duration_ms",
      "opencode_permission_evaluation_total",
      "opencode_tool_call_total",
      "opencode_tool_call_duration_ms",
      "opencode_session_lifecycle_total",
    ])
    .meta({
      ref: "MetricName",
    })
  export type Name = z.infer<typeof Name>

  export const Sample = z
    .object({
      name: Name,
      time: z.number().int().nonnegative(),
      value: z.number(),
      labels: z.record(z.string(), z.string()),
    })
    .meta({
      ref: "MetricSample",
    })
  export type Sample = z.infer<typeof Sample>

  export const CAPACITY = 1000
  const samples: Sample[] = []

  export function emit(name: Name, labels: Record<string, string> = {}, value = 1) {
    samples.push({
      name,
      labels,
      value,
      time: Date.now(),
    })
    if (samples.length > CAPACITY) samples.splice(0, samples.length - CAPACITY)
  }

  export function time(name: Name, labels: Record<string, string>, start: number) {
    emit(name, labels, Date.now() - start)
  }

  export function list() {
    return [...samples]
  }

  export function clear() {
    samples.splice(0)
  }
}
