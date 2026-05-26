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

  const Policy = z.enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"])
  const Depends = z.union([Text, z.array(Text)]).default([])
  const FlatCall = z
    .object({
      id: Text,
      type: z.enum(["tool", "agent"]),
      title: Text.optional(),
      name: Text,
      args: JsonRecord.default({}),
      depends: Depends,
      result: Policy.default("summary"),
    })
    .strict()

  const LegacyCall = FlatCall.extend({
    type: z.enum(["tool", "agent"]).optional(),
    kind: z.enum(["tool", "agent"]).optional(),
    name: Text.optional(),
    tool: Text.optional(),
    after: Depends,
  }).superRefine((value, ctx) => {
    if (!value.name && !value.tool) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "call requires name" })
    }
  })

  const FlatAct = z
    .object({
      kind: z.literal("act"),
      message: z.string().default(""),
      calls: z.array(FlatCall).min(1),
    })
    .strict()

  const FlatAnswer = z
    .object({
      kind: z.literal("answer"),
      message: z.string().default(""),
    })
    .strict()

  const FlatDone = z
    .object({
      kind: z.literal("done"),
      message: z.string().default(""),
    })
    .strict()

  export const Structured = z.discriminatedUnion("kind", [FlatAct, FlatAnswer, FlatDone])

  const LegacyAct = z
    .object({
      kind: z.literal("act"),
      message: z.string().default(""),
      say: z.string().default(""),
      calls: z.preprocess((input) => (typeof input === "string" ? actions(input) : input), z.array(LegacyCall).min(1)),
    })
    .strict()

  const LegacyAnswer = z
    .object({
      kind: z.literal("answer"),
      message: z.string().default(""),
      say: z.string().default(""),
    })
    .strict()

  const LegacyDone = z
    .object({
      kind: z.literal("done"),
      message: z.string().default(""),
      say: z.string().default(""),
    })
    .strict()

  const Legacy = z.discriminatedUnion("kind", [LegacyAct, LegacyAnswer, LegacyDone])

  export const Declaration = z.preprocess((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input
    const value = input as globalThis.Record<string, unknown>
    const simple = flat(value)
    if (simple) return simple
    if ("payload" in value) return input
    if (!("intent" in value)) return input
    const next = { ...value }
    if (next.intent === "execute") {
      next.payload = { type: "action_graph", actions: actions(next.actions) }
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
      input: JsonRecord.optional(),
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

  function actions(input: unknown) {
    if (Array.isArray(input)) return input
    if (typeof input !== "string") return []
    const patched = between(input)
    const json = decode(input) ?? decode(patched) ?? decode(end(patched))
    if (Array.isArray(json)) return json
    return []
  }

  function decode(input: string): unknown | undefined {
    try {
      return JSON.parse(input)
    } catch {
      return undefined
    }
  }

  function between(input: string) {
    return input
      .replace(/(?<!\})\}(\s*,\s*)(?=\{"type"\s*:\s*"action")/g, "}}$1")
      .replace(/(?<!\})\}(\s*,\s*)(?=\{"id"\s*:)/g, "}}$1")
      .replace(/("result_policy"\s*:\s*"[^"]+")(\s*,\s*)(?=\{"type"\s*:\s*"action")/g, "$1}$2")
  }

  function end(input: string) {
    return input
      .replace(/(?<!\})\}(\s*\])\s*$/g, "}}$1")
      .replace(/("result_policy"\s*:\s*"[^"]+")(\s*\])\s*$/g, "$1}$2")
  }

  function flat(input: globalThis.Record<string, unknown>) {
    const parsed = Structured.safeParse(input)
    if (parsed.success) return flatParsed(parsed.data)
    const legacy = Legacy.safeParse(input)
    if (legacy.success) return flatParsed(legacy.data)
  }

  function flatParsed(parsed: z.infer<typeof Structured> | z.infer<typeof Legacy>) {
    if (parsed.kind === "act") {
      const calls = parsed.calls
      return {
        type: "agent.protocol.output",
        version: "1",
        intent: "execute",
        persist: false,
        title: calls[0]?.title ?? name(calls[0]),
        message: "say" in parsed ? parsed.message || parsed.say : parsed.message,
        execution: { strategy: "sequential" },
        payload: {
          type: "action_graph",
          actions: calls.map((item) => ({
            type: "action",
            id: item.id,
            title: item.title ?? item.id,
            operation: operation(item),
            executor: { type: type(item), target: target(item), capabilities: capabilities(item) },
            input: item.args,
            depends_on: deps(item.depends && item.depends.length > 0 ? item.depends : after(item)),
            context_refs: [],
            result_policy: item.result,
          })),
        },
      }
    }
    return {
      type: "agent.protocol.output",
      version: "1",
      intent: parsed.kind === "answer" ? "respond" : "stop",
      persist: false,
      message: "say" in parsed ? parsed.message || parsed.say : parsed.message,
      execution: { strategy: "sequential" },
      payload: { type: "message" },
    }
  }

  function deps(input: string | string[] | undefined) {
    if (!input) return []
    if (Array.isArray(input)) return input
    if (input.length === 0) return []
    return [input]
  }

  function name(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall> | undefined) {
    return input?.name ?? (input && "tool" in input ? input.tool : undefined) ?? "call"
  }

  function kind(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    return input.type ?? ("kind" in input ? input.kind : undefined) ?? "tool"
  }

  function type(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    if (kind(input) === "tool" && name(input) === "task") return "agent"
    return kind(input)
  }

  function target(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    if (type(input) === "agent" && name(input) === "task") return "auto"
    return name(input)
  }

  function operation(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    if (type(input) !== "agent") return name(input)
    return agent(input) ?? "agent"
  }

  function capabilities(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    const value = agent(input)
    return value && target(input) === "auto" ? [value] : []
  }

  function agent(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    const value = input.args.subagent_type ?? input.args.agent ?? input.args.agent_type
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  function after(input: z.infer<typeof LegacyCall> | z.infer<typeof FlatCall>) {
    return "after" in input ? input.after : undefined
  }
}
