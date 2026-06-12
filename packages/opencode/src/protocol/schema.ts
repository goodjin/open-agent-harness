import z from "zod"

export namespace AgentProtocol {
  const Text = z.string().trim().min(1)
  const Ref = Text
  const JsonRecord = z.record(z.string(), z.unknown())
  export const VerificationRole = z.enum(["test", "review"])
  export type VerificationRole = z.infer<typeof VerificationRole>

  export const Verification = z
    .object({
      role: VerificationRole.optional(),
      worker: Text.optional(),
      required: z.boolean().optional(),
      reason: Text.optional(),
      system: z.boolean().optional(),
      allow_skip_on_no_change: z.boolean().optional(),
    })
    .strict()
  export type Verification = z.infer<typeof Verification>

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
      verification: Verification.optional(),
      result_policy: z
        .enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"])
        .default("summary"),
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
      outcome: z.enum(["success", "failure", "error", "reply"]).optional(),
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
    })

  const Policy = z.enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"])
  const Depends = z.union([Text, z.array(Text)]).default([])
  const V2Depends = z.array(Text).default([])
  const V2Option = z.object({
    id: Text,
    label: Text,
    description: Text.optional(),
    disabled: z.boolean().optional(),
  })
  const V2Field = z.object({
    id: Text,
    label: Text,
    type: z.enum(["text", "textarea", "single", "multi", "confirm", "number"]),
    required: z.boolean().optional(),
    options: z.array(V2Option).optional(),
    default: z.unknown().optional(),
    validation: JsonRecord.optional(),
  })
  const V2Tool = z.object({
    id: Text,
    kind: z.literal("tool"),
    title: Text.optional(),
    target: Text,
    args: JsonRecord.default({}),
    depends: V2Depends,
    result: Policy.default("summary"),
  })
  const V2Agent = z.object({
    id: Text,
    kind: z.literal("agent"),
    title: Text.optional(),
    target: Text,
    prompt: Text,
    capabilities: z.array(Text).default([]),
    context_refs: z.array(Ref).default([]),
    depends: V2Depends,
    verification: Verification.optional(),
    result: Policy.default("summary"),
  })
  const V2Ask = z.object({
    id: Text,
    kind: z.literal("ask"),
    title: Text.optional(),
    prompt: Text,
    mode: z.enum(["text", "single", "multi", "confirm", "form"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.array(V2Option).optional(),
    fields: z.array(V2Field).optional(),
    allow_custom: z.boolean().optional(),
    min_selected: z.number().int().nonnegative().optional(),
    max_selected: z.number().int().positive().optional(),
    depends: V2Depends,
    result: Policy.default("summary"),
  })
  const V2Input = z.object({
    id: Text,
    kind: z.literal("input"),
    title: Text.optional(),
    prompt: Text,
    mode: z.enum(["text", "single", "multi", "form"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.array(V2Option).optional(),
    fields: z.array(V2Field).optional(),
    allow_custom: z.boolean().optional(),
    min_selected: z.number().int().nonnegative().optional(),
    max_selected: z.number().int().positive().optional(),
    depends: V2Depends,
    result: Policy.default("summary"),
  })
  const V2Confirm = z.object({
    id: Text,
    kind: z.literal("confirm"),
    title: Text.optional(),
    prompt: Text,
    plan: Text,
    depends: V2Depends,
    result: Policy.default("summary"),
  })
  const V2Wait = z.object({
    id: Text,
    kind: z.literal("wait"),
    title: Text.optional(),
    target: Text,
    reason: Text.optional(),
    depends: V2Depends,
    result: Policy.default("summary"),
  })
  const V2Answer = z.object({
    id: Text,
    kind: z.literal("answer"),
    title: Text.optional(),
    message: z.string().default(""),
    answer: z.string().optional(),
    text: z.string().optional(),
    depends: V2Depends,
  })
  const V2Done = z.object({
    id: Text,
    kind: z.literal("done"),
    title: Text.optional(),
    message: z.string().default(""),
    depends: V2Depends,
  })
  const ResultFields = {
    id: Text,
    title: Text.optional(),
    message: z.string().default(""),
    answer: z.string().optional(),
    text: z.string().optional(),
    summary: z.string().optional(),
    changed_files: z.array(Text).default([]),
    depends: V2Depends,
  }
  const V2Success = z.object({ ...ResultFields, kind: z.literal("success") })
  const V2Failure = z.object({ ...ResultFields, kind: z.literal("failure") })
  const V2Error = z.object({ ...ResultFields, kind: z.literal("error") })
  const V2Reply = z.object({ ...ResultFields, kind: z.literal("reply") })
  const V2Terminal = z.discriminatedUnion("kind", [V2Answer, V2Done, V2Success, V2Failure, V2Error, V2Reply])
  const V2Item = z.discriminatedUnion("kind", [
    V2Tool,
    V2Agent,
    V2Input,
    V2Ask,
    V2Confirm,
    V2Wait,
    V2Answer,
    V2Done,
    V2Success,
    V2Failure,
    V2Error,
    V2Reply,
  ])
  const V2 = z.object({
    version: z.literal("2"),
    title: Text.optional(),
    strategy: z.enum(["sequential", "dag"]).default("sequential"),
    items: z.array(V2Item).min(1),
  })
  const FlatCall = z.object({
    id: Text,
    type: z.enum(["tool", "agent"]),
    title: Text.optional(),
    name: Text,
    args: JsonRecord.default({}),
    depends: Depends,
    result: Policy.default("summary"),
  })

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

  const FlatAct = z.object({
    kind: z.literal("act"),
    message: z.string().default(""),
    calls: z.array(FlatCall).min(1),
  })

  const FlatAnswer = z.object({
    kind: z.literal("answer"),
    message: z.string().default(""),
    answer: z.string().optional(),
    text: z.string().optional(),
  })

  const FlatDone = z.object({
    kind: z.literal("done"),
    message: z.string().default(""),
  })
  const FlatSuccess = z.object({
    kind: z.literal("success"),
    message: z.string().default(""),
    summary: z.string().optional(),
    changed_files: z.array(Text).default([]),
  })
  const FlatFailure = z.object({
    kind: z.literal("failure"),
    message: z.string().default(""),
    summary: z.string().optional(),
    changed_files: z.array(Text).default([]),
  })
  const FlatError = z.object({
    kind: z.literal("error"),
    message: z.string().default(""),
    summary: z.string().optional(),
    changed_files: z.array(Text).default([]),
  })
  const FlatReply = z.object({
    kind: z.literal("reply"),
    message: z.string().default(""),
    answer: z.string().optional(),
    text: z.string().optional(),
    summary: z.string().optional(),
    changed_files: z.array(Text).default([]),
  })

  export const Structured = z.discriminatedUnion("kind", [
    FlatAct,
    FlatAnswer,
    FlatDone,
    FlatSuccess,
    FlatFailure,
    FlatError,
    FlatReply,
  ])
  export const OutputSchema = {
    type: "object",
    properties: {
      version: {
        type: "string",
        enum: ["2"],
        default: "2",
      },
      title: {
        type: "string",
        minLength: 1,
      },
      strategy: {
        type: "string",
        enum: ["sequential", "dag"],
        default: "sequential",
      },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            kind: {
              type: "string",
              enum: ["tool", "agent", "input", "confirm", "answer", "done", "success", "failure", "error", "reply"],
            },
            title: { type: "string", minLength: 1 },
            target: { type: "string", minLength: 1 },
            prompt: { type: "string", minLength: 1 },
            plan: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
            summary: { type: "string" },
            changed_files: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
            verification: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["test", "review"] },
                worker: { type: "string", minLength: 1 },
                required: { type: "boolean" },
                reason: { type: "string", minLength: 1 },
                system: { type: "boolean" },
                allow_skip_on_no_change: { type: "boolean" },
              },
              additionalProperties: false,
            },
            mode: { type: "string", enum: ["text", "single", "multi", "form"] },
            args: { type: "object", additionalProperties: true, default: {} },
            capabilities: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
            context_refs: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
            depends: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
            result: {
              type: "string",
              enum: ["summary", "structured", "full", "on_failure", "on_demand", "adaptive"],
              default: "summary",
            },
            required: { type: "boolean" },
            default: {},
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1 },
                  label: { type: "string", minLength: 1 },
                  description: { type: "string", minLength: 1 },
                  disabled: { type: "boolean" },
                },
                required: ["id", "label"],
                additionalProperties: false,
              },
            },
            fields: { type: "array", items: { type: "object", additionalProperties: true } },
            allow_custom: { type: "boolean" },
            min_selected: { type: "integer", minimum: 0 },
            max_selected: { type: "integer", minimum: 1 },
          },
          required: ["id", "kind"],
          additionalProperties: false,
          allOf: [
            { if: { properties: { kind: { const: "tool" } } }, then: { required: ["target"] } },
            { if: { properties: { kind: { const: "agent" } } }, then: { required: ["target", "prompt"] } },
            { if: { properties: { kind: { const: "input" } } }, then: { required: ["prompt", "mode"] } },
            { if: { properties: { kind: { const: "confirm" } } }, then: { required: ["prompt", "plan"] } },
            {
              if: { properties: { kind: { enum: ["answer", "reply"] } } },
              then: { anyOf: [{ required: ["message"] }, { required: ["answer"] }, { required: ["text"] }] },
            },
          ],
        },
      },
      kind: {
        type: "string",
        enum: ["act", "answer", "done", "success", "failure", "error", "reply"],
      },
      message: {
        type: "string",
        default: "",
      },
      calls: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              minLength: 1,
            },
            type: {
              type: "string",
              enum: ["tool", "agent"],
            },
            title: {
              type: "string",
              minLength: 1,
            },
            name: {
              type: "string",
              minLength: 1,
            },
            args: {
              type: "object",
              additionalProperties: true,
              default: {},
            },
            depends: {
              type: "array",
              items: {
                type: "string",
                minLength: 1,
              },
              default: [],
            },
            result: {
              type: "string",
              enum: ["summary", "structured", "full", "on_failure", "on_demand", "adaptive"],
              default: "summary",
            },
          },
          required: ["id", "type", "name"],
          additionalProperties: false,
        },
      },
    },
    required: [],
    allOf: [
      {
        if: {
          required: ["items"],
        },
        then: {
          required: ["version", "items"],
          not: {
            required: ["kind"],
          },
        },
      },
      {
        if: {
          properties: {
            kind: {
              const: "act",
            },
          },
          required: ["kind"],
        },
        then: {
          required: ["calls"],
        },
      },
      {
        if: {
          properties: {
            kind: {
              enum: ["answer", "done", "success", "failure", "error", "reply"],
            },
          },
          required: ["kind"],
        },
        then: {
          not: {
            required: ["calls"],
          },
        },
      },
    ],
    additionalProperties: false,
  } as const

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
      answer: z.string().optional(),
      text: z.string().optional(),
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
    const cleaned = stripNone(input)
    if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) return cleaned
    const value = cleaned as globalThis.Record<string, unknown>
    const wrap = wrapped(value)
    if (wrap) return wrap
    const simple = flat(value)
    if (simple) return simple
    if ("payload" in value) return cleaned
    if (!("intent" in value)) return cleaned
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
      depends_on: z.array(Text).default([]),
      verification: Verification.optional(),
      status: Status,
      summary: z.string().default(""),
      output: z.string().optional(),
      error: z.string().optional(),
      sessionID: Text.optional(),
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
    if (
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (input as { version?: unknown }).version === "2"
    ) {
      V2.parse(input)
    }
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

  export const NONE_DEPENDENCY = "none"

  // stripNone walks the raw declaration and removes the literal "none"
  // sentinel from every depends / depends_on array. The schema validator
  // must not see "none" or it will report a missing-dependency error. The
  // runtime reads back the original sentinel from the action graph and
  // treats it as "this call intentionally has no upstream dependency".
  function stripNone(input: unknown): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input
    const value = input as globalThis.Record<string, unknown>
    if ("depends_on" in value && Array.isArray(value.depends_on)) {
      value.depends_on = (value.depends_on as unknown[]).filter((item) => item !== NONE_DEPENDENCY)
    }
    if ("depends" in value && Array.isArray(value.depends)) {
      value.depends = (value.depends as unknown[]).filter((item) => item !== NONE_DEPENDENCY)
    }
    if (Array.isArray(value.items)) {
      for (const item of value.items as unknown[]) stripNone(item)
    } else if (Array.isArray(value.calls)) {
      for (const item of value.calls as unknown[]) stripNone(item)
    } else if (Array.isArray(value.actions)) {
      for (const item of value.actions as unknown[]) stripNone(item)
    } else if (value.payload && typeof value.payload === "object") {
      stripNone(value.payload)
    }
    return input
  }

  function wrapped(input: globalThis.Record<string, unknown>) {
    const raw = input.input
    const json = typeof raw === "string" ? decode(raw) : raw
    if (!json || typeof json !== "object" || Array.isArray(json)) return
    const value = json as globalThis.Record<string, unknown>
    if (!("kind" in value)) return
    return flat(value)
  }

  function decode(input: string): unknown | undefined {
    try {
      return JSON.parse(input)
    } catch {
      try {
        return JSON.parse(escape(input))
      } catch {
        return undefined
      }
    }
  }

  function escape(input: string) {
    let quoted = false
    let slash = false
    return [...input]
      .map((char) => {
        if (slash) {
          slash = false
          return char
        }
        if (char === "\\") {
          slash = true
          return char
        }
        if (char === '"') {
          quoted = !quoted
          return char
        }
        if (!quoted) return char
        if (char === "\n") return "\\n"
        if (char === "\r") return "\\r"
        if (char === "\t") return "\\t"
        return char
      })
      .join("")
  }

  function between(input: string) {
    return input
      .replace(/(?<!\})\}(\s*,\s*)(?=\{"type"\s*:\s*"action")/g, "}}$1")
      .replace(/(?<!\})\}(\s*,\s*)(?=\{"id"\s*:)/g, "}}$1")
      .replace(/(?<!\})\}(\s*,\s*)(?=\{"depends"\s*:)/g, "}}$1")
      .replace(/("result_policy"\s*:\s*"[^"]+")(\s*,\s*)(?=\{"type"\s*:\s*"action")/g, "$1}$2")
  }

  function end(input: string) {
    return input
      .replace(/(?<!\})\}(\s*\])\s*$/g, "}}$1")
      .replace(/("result_policy"\s*:\s*"[^"]+")(\s*\])\s*$/g, "$1}$2")
  }

  function flat(input: globalThis.Record<string, unknown>) {
    const v2 = V2.safeParse(input)
    if (v2.success) return v2Parsed(v2.data)
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
      intent: response(parsed.kind) ? "respond" : "stop",
      persist: false,
      message: message(parsed),
      outcome: outcome(parsed.kind),
      execution: { strategy: "sequential" },
      payload: { type: "message" },
    }
  }

  function v2Parsed(parsed: z.infer<typeof V2>) {
    const terminal = parsed.items.find((item): item is z.infer<typeof V2Terminal> => done(item.kind))
    const actions = parsed.items.filter(
      (item): item is Exclude<z.infer<typeof V2Item>, z.infer<typeof V2Terminal>> => !done(item.kind),
    )
    if (actions.length === 0) {
      return {
        type: "agent.protocol.output",
        version: "1",
        intent: terminal && response(terminal.kind) ? "respond" : "stop",
        persist: false,
        title: parsed.title ?? terminal?.title,
        message: terminal ? message(terminal) : "",
        outcome: terminal ? outcome(terminal.kind) : "success",
        execution: { strategy: parsed.strategy },
        payload: { type: "message" },
      }
    }
    return {
      type: "agent.protocol.output",
      version: "1",
      intent: "execute",
      persist: false,
      title: parsed.title ?? actions[0]?.title ?? actions[0]?.id,
      message: terminal ? message(terminal) : undefined,
      outcome: terminal ? outcome(terminal.kind) : undefined,
      execution: { strategy: parsed.strategy },
      payload: {
        type: "action_graph",
        actions: actions.map((item) => action(item)),
      },
    }
  }

  function action(input: Exclude<z.infer<typeof V2Item>, z.infer<typeof V2Terminal>>) {
    if (input.kind === "tool") {
      return {
        type: "action",
        id: input.id,
        title: input.title ?? input.id,
        operation: input.target,
        executor: { type: "tool", target: input.target, capabilities: [] },
        input: input.args,
        depends_on: input.depends,
        context_refs: [],
        result_policy: input.result,
      }
    }
    if (input.kind === "agent") {
      return {
        type: "action",
        id: input.id,
        title: input.title ?? input.id,
        operation: input.target === "auto" ? "agent" : input.target,
        executor: { type: "agent", target: input.target, capabilities: input.capabilities },
        input: { prompt: input.prompt },
        depends_on: input.depends,
        context_refs: input.context_refs,
        verification: input.verification,
        result_policy: input.result,
      }
    }
    if (input.kind === "wait") {
      return {
        type: "action",
        id: input.id,
        title: input.title ?? input.id,
        operation: input.target,
        executor: { type: "runtime", target: "wait", capabilities: [] },
        input: { target: input.target, reason: input.reason },
        depends_on: input.depends,
        context_refs: [],
        result_policy: input.result,
      }
    }
    if (input.kind === "confirm") {
      return {
        type: "action",
        id: input.id,
        title: input.title ?? input.id,
        operation: "confirm",
        executor: { type: "human", target: "user", capabilities: ["confirmation"] },
        input: { prompt: input.prompt, plan: input.plan },
        depends_on: input.depends,
        context_refs: [],
        result_policy: input.result,
      }
    }
    return {
      type: "action",
      id: input.id,
      title: input.title ?? input.id,
      operation: "input",
      executor: { type: "human", target: "user", capabilities: [input.mode] },
      input: ask(input),
      depends_on: input.depends,
      context_refs: [],
      result_policy: input.result,
    }
  }

  function ask(input: z.infer<typeof V2Ask> | z.infer<typeof V2Input>) {
    return {
      prompt: input.prompt,
      mode: input.mode,
      required: input.required,
      default: input.default,
      options: input.options,
      fields: input.fields,
      allow_custom: input.allow_custom,
      min_selected: input.min_selected,
      max_selected: input.max_selected,
    }
  }

  function deps(input: string | string[] | undefined) {
    if (!input) return []
    if (Array.isArray(input)) return input
    if (input.length === 0) return []
    return [input]
  }

  function done(input: string) {
    return (
      input === "answer" ||
      input === "done" ||
      input === "success" ||
      input === "failure" ||
      input === "error" ||
      input === "reply"
    )
  }

  function response(input: string) {
    return input === "answer" || input === "reply"
  }

  function outcome(input: string) {
    if (input === "failure" || input === "error" || input === "reply") return input
    return "success"
  }

  function message(input: {
    kind: string
    message?: string
    answer?: string
    text?: string
    summary?: string
    changed_files?: string[]
    say?: string
  }) {
    const msg = input.message || input.answer || input.text || input.say || ""
    const sum = input.summary?.trim()
    const files = input.changed_files?.length ? `Changed files: ${input.changed_files.join(", ")}` : ""
    return [msg, sum, files].filter((item): item is string => typeof item === "string" && item.length > 0).join("\n\n")
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
