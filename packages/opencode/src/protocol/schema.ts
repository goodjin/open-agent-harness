import z from "zod"

export namespace AgentProtocol {
  const Text = z.string().trim().min(1)
  const Ref = Text
  const JsonRecord = z.record(z.string(), z.unknown())

  export const Executor = z
    .object({
      type: z.enum(["tool", "agent", "runtime", "human"]),
      target: Text.default("auto"),
      capabilities: z.array(Text).default([]),
    })
    .strict()
  export type Executor = z.infer<typeof Executor>

  export const Action = z
    .object({
      type: z.literal("action").default("action"),
      id: Text,
      title: Text,
      description: Text.optional(),
      reason: Text.optional(),
      operation: Text,
      executor: Executor,
      input: JsonRecord.optional(),
      depends_on: z.array(Text).default([]),
      context_refs: z.array(Ref).default([]),
      prompt_ref: Ref.optional(),
      result_policy: z.enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"]).default("summary"),
    })
    .strict()
  export type Action = z.infer<typeof Action>

  const StructuredAction = Action.superRefine((value, ctx) => {
    if (value.executor.type === "tool" && value.executor.target === "auto") {
      ctx.addIssue({
        code: "custom",
        path: ["executor", "target"],
        message: "tool executor target must be a concrete tool id, not auto",
      })
    }
  })

  const ActionGraph = z
    .object({
      type: z.literal("action_graph"),
      actions: z.array(Action).min(1),
    })
    .strict()

  const Message = z
    .object({
      type: z.literal("message"),
    })
    .strict()

  const Canonical = z
    .object({
      type: z.enum(["agent.protocol", "agent.protocol.output"]),
      version: z.literal("1"),
      intent: z.enum(["execute", "respond", "stop"]),
      persist: z.boolean().default(false),
      title: Text.optional(),
      message: z.string().optional(),
      response_ref: Ref.optional(),
      execution: z
        .object({
          strategy: z.enum(["sequential", "dag"]).default("sequential"),
        })
        .strict()
        .default({ strategy: "sequential" }),
      payload: z.union([ActionGraph, Message]),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.intent === "execute" && value.payload.type !== "action_graph") {
        ctx.addIssue({ code: "custom", path: ["payload"], message: "execute intent requires action_graph payload" })
      }
      if (value.intent !== "execute" && value.payload.type !== "message") {
        ctx.addIssue({ code: "custom", path: ["payload"], message: `${value.intent} intent requires message payload` })
      }
      const ids = new Set<string>()
      const actions = value.payload.type === "action_graph" ? value.payload.actions : []
      for (const item of actions) {
        if (ids.has(item.id)) {
          ctx.addIssue({ code: "custom", path: ["payload", "actions"], message: `duplicate action id: ${item.id}` })
        }
        ids.add(item.id)
      }
      for (const item of actions) {
        for (const dep of item.depends_on) {
          if (!ids.has(dep)) {
            ctx.addIssue({
              code: "custom",
              path: ["payload", "actions", item.id, "depends_on"],
              message: `missing dependency '${dep}' for action '${item.id}'`,
            })
          }
        }
      }
    })

  export const Structured = z
    .object({
      type: z.literal("agent.protocol.output"),
      version: z.literal("1"),
      intent: z.enum(["execute", "respond", "stop"]),
      persist: z.boolean().default(false),
      title: Text.optional(),
      message: z.string().default(""),
      actions: z.array(StructuredAction).default([]),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.intent === "execute" && value.actions.length === 0) {
        ctx.addIssue({ code: "custom", path: ["actions"], message: "execute intent requires at least one action" })
      }
      if (value.intent !== "execute" && value.actions.length > 0) {
        ctx.addIssue({ code: "custom", path: ["actions"], message: `${value.intent} intent cannot include actions` })
      }
    })

  export const Declaration = z.preprocess((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input
    const value = input as globalThis.Record<string, unknown>
    if ("payload" in value) return input
    if (!("intent" in value)) return input
    const next = { ...value }
    if (next.intent === "execute") {
      next.payload = { type: "action_graph", actions: Array.isArray(next.actions) ? next.actions : [] }
    } else {
      next.payload = { type: "message" }
    }
    delete next.actions
    return next
  }, Canonical)
  export type Declaration = z.infer<typeof Canonical>

  export const Status = z.enum(["pending", "running", "completed", "blocked", "failed", "skipped"])
  export type Status = z.infer<typeof Status>

  export const ResultAction = z
    .object({
      id: Text,
      title: Text,
      operation: Text,
      executor: Executor,
      status: Status,
      summary: z.string().default(""),
      output: z.string().optional(),
      error: z.string().optional(),
      tool_call_ids: z.array(Text).default([]),
      duration_ms: z.number().int().nonnegative().default(0),
      time: z
        .object({
          started: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict()
  export type ResultAction = z.infer<typeof ResultAction>

  export const Result = z
    .object({
      type: z.literal("agent.protocol.result"),
      version: z.literal("1"),
      run_id: Text,
      status: z.enum(["completed", "blocked", "failed"]),
      title: Text.optional(),
      actions: z.array(ResultAction),
      summary: z.string(),
      time: z
        .object({
          started: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative().optional(),
        })
        .strict(),
      metrics: z
        .object({
          actions: z.number().int().nonnegative(),
          internal_tool_calls: z.number().int().nonnegative(),
          direct_model_tool_calls: z.number().int().nonnegative(),
          model_visible_bytes: z.number().int().nonnegative(),
          raw_output_bytes: z.number().int().nonnegative(),
          duration_ms: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict()
  export type Result = z.infer<typeof Result>

  export function parse(input: unknown) {
    return Declaration.parse(input)
  }
}
