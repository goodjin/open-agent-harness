type Rec = Record<string, unknown>

export type EdgeKind =
  | "prerequisite"
  | "verifier"
  | "reviewer"
  | "arbiter"
  | "fallback"
  | "recovery"
  | "monitor"
  | "splitter"
  | "aggregator"
  | "escalation"
  | "peer"
  | "blocker"

export type FailurePolicy = "block" | "continue" | "retry" | "escalate"

export type Limits = {
  max_depth?: number
  max_parallel?: number
}

export type Source = {
  agent?: string
  action?: string
  depth?: number
}

export type Edge = {
  kind: EdgeKind
  target: string
  trigger?: unknown
  required?: boolean
  limits?: Limits
  dedupe_key?: string
  failure_policy?: FailurePolicy
  depends?: readonly string[]
  input?: Rec
  raw: Rec
}

export type Diagnostic = {
  code: "unsupported_kind" | "trigger_mismatch" | "missing_target" | "max_depth" | "max_parallel"
  message: string
  edge?: Rec
  limit?: number
}

export type Context = {
  meta?: {
    id?: string
    collaboration?: {
      edges?: readonly Rec[]
      limits?: Limits
    }
  }
  collaboration?: {
    edges?: readonly Rec[]
    limits?: Limits
  }
  trigger?: unknown
  projection?: unknown
  trace?: readonly unknown[]
  source?: Source
  limits?: Limits
}

export type PlanItem = {
  kind: "action" | "assignment" | "handoff"
  id: string
  edge_kind: EdgeKind
  target: string
  required: boolean
  failure_policy: FailurePolicy
  dedupe_key: string
  depends: string[]
  trigger?: unknown
  input: Rec
  source: Source
}

export type Plan = {
  kind: "collaboration.plan"
  source: Source
  trigger?: unknown
  items: PlanItem[]
  diagnostics: Diagnostic[]
  limits: Limits
}

export type Match = {
  edges: Edge[]
  diagnostics: Diagnostic[]
}

export namespace AgentCollaboration {
  const kinds = new Set<EdgeKind>([
    "prerequisite",
    "verifier",
    "reviewer",
    "arbiter",
    "fallback",
    "recovery",
    "monitor",
    "splitter",
    "aggregator",
    "escalation",
    "peer",
    "blocker",
  ])

  export function matchEdges(ctx: Context): Match {
    return raw(ctx).reduce<Match>(
      (out, item) => {
        const edge = parse(item)
        if (!edge) {
          out.diagnostics.push({
            code: "unsupported_kind",
            message: "Collaboration edge kind is not supported",
            edge: item,
          })
          return out
        }
        if (!edge.target) {
          out.diagnostics.push({
            code: "missing_target",
            message: "Collaboration edge target is required",
            edge: item,
          })
          return out
        }
        if (!match(edge, ctx)) {
          out.diagnostics.push({
            code: "trigger_mismatch",
            message: "Collaboration edge trigger does not match current trigger",
            edge: item,
          })
          return out
        }
        out.edges.push(edge)
        return out
      },
      { edges: [] as Edge[], diagnostics: [] as Diagnostic[] },
    )
  }

  export function dedupe(edges: readonly Edge[]): Edge[] {
    const seen = new Set<string>()
    return edges.filter((edge) => {
      const key = dedupeKey(edge)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  export function checkLimits(input: { limits?: Limits; source?: Source; count: number; edge?: Rec }): Diagnostic[] {
    const out: Diagnostic[] = []
    if (typeof input.limits?.max_depth === "number" && (input.source?.depth ?? 0) > input.limits.max_depth) {
      out.push({
        code: "max_depth",
        message: "Collaboration depth exceeds max_depth",
        edge: input.edge,
        limit: input.limits.max_depth,
      })
    }
    if (typeof input.limits?.max_parallel === "number" && input.count > input.limits.max_parallel) {
      out.push({
        code: "max_parallel",
        message: "Collaboration plan exceeds max_parallel",
        edge: input.edge,
        limit: input.limits.max_parallel,
      })
    }
    return out
  }

  export function expandEdge(edge: Edge, ctx: Context): PlanItem {
    const src = ctx.source ?? {}
    return {
      kind: item(edge.kind),
      id: id(edge, src),
      edge_kind: edge.kind,
      target: edge.target,
      required: edge.required === true,
      failure_policy: edge.failure_policy ?? policy(edge),
      dedupe_key: key(edge, src),
      depends: [...(edge.depends ?? [])],
      trigger: ctx.trigger,
      input: edge.input ?? {},
      source: src,
    }
  }

  export function plan(ctx: Context): Plan {
    const lim = limits(ctx)
    const matched = matchEdges(ctx)
    const unique = dedupe(matched.edges)
    const depth = checkLimits({ limits: lim, source: ctx.source, count: unique.length }).filter((item) => item.code === "max_depth")
    const blocked = depth.length
      ? []
      : unique.flatMap((edge) =>
        checkLimits({ limits: { ...lim, ...(edge.limits ?? {}) }, source: ctx.source, count: 1, edge: edge.raw }).filter((item) => item.code === "max_depth"),
      )
    const kept = blocked.length ? [] : unique
    const max = typeof lim.max_parallel === "number" ? lim.max_parallel : unique.length
    const items = depth.length ? [] : kept.slice(0, max).map((edge) => expandEdge(edge, ctx))
    const extra = unique.length > max ? checkLimits({ limits: lim, source: ctx.source, count: unique.length }).filter((item) => item.code === "max_parallel") : []
    return {
      kind: "collaboration.plan",
      source: ctx.source ?? {},
      trigger: ctx.trigger,
      items,
      diagnostics: [...matched.diagnostics, ...depth, ...blocked, ...extra],
      limits: lim,
    }
  }

  function raw(ctx: Context): readonly Rec[] {
    return ctx.collaboration?.edges ?? ctx.meta?.collaboration?.edges ?? []
  }

  function limits(ctx: Context) {
    return {
      ...(ctx.meta?.collaboration?.limits ?? {}),
      ...(ctx.collaboration?.limits ?? {}),
      ...(ctx.limits ?? {}),
    }
  }

  function parse(input: Rec): Edge | undefined {
    const val = text(input.kind) ?? text(input.mode) ?? text(input.type)
    if (!val || !kinds.has(val as EdgeKind)) return undefined
    return {
      kind: val as EdgeKind,
      target: text(input.target) ?? text(input.to) ?? "",
      trigger: input.trigger ?? input.on,
      required: input.required === true,
      limits: rec(input.limits) as Limits | undefined,
      dedupe_key: text(input.dedupe_key),
      failure_policy: ftext(input.failure_policy),
      depends: list(input.depends ?? input.depends_on),
      input: rec(input.input) ?? rec(input.args),
      raw: input,
    }
  }

  function match(edge: Edge, ctx: Context) {
    if (edge.trigger === undefined) return true
    const vals = values(ctx)
    if (typeof edge.trigger === "string") return vals.includes(edge.trigger)
    if (Array.isArray(edge.trigger)) return edge.trigger.some((item) => typeof item === "string" && vals.includes(item))
    const trig = rec(edge.trigger)
    if (!trig) return false
    return Object.entries(trig).every(([key, val]) => val === read(ctx.trigger, key) || val === read(ctx.projection, key) || val === read(last(ctx.trace), key))
  }

  function values(ctx: Context) {
    return [ctx.trigger, read(ctx.trigger, "kind"), read(ctx.trigger, "event"), read(ctx.trigger, "status"), read(ctx.trigger, "name")]
      .filter((item): item is string => typeof item === "string" && item.length > 0)
  }

  function read(input: unknown, key: string) {
    const obj = rec(input)
    if (!obj) return undefined
    return obj[key]
  }

  function last(input: readonly unknown[] | undefined) {
    return input?.at(-1)
  }

  function item(kind: EdgeKind): PlanItem["kind"] {
    if (kind === "arbiter" || kind === "escalation" || kind === "reviewer") return "handoff"
    if (kind === "prerequisite" || kind === "peer" || kind === "splitter" || kind === "aggregator") return "assignment"
    return "action"
  }

  function policy(edge: Edge): FailurePolicy {
    if (edge.required) return "block"
    if (edge.kind === "verifier" || edge.kind === "reviewer" || edge.kind === "arbiter" || edge.kind === "blocker") return "block"
    if (edge.kind === "recovery") return "retry"
    if (edge.kind === "escalation") return "escalate"
    return "continue"
  }

  function id(edge: Edge, src: Source) {
    return slug([src.agent ?? "agent", edge.kind, edge.target, edge.dedupe_key].filter((item): item is string => !!item).join("-"))
  }

  function dedupeKey(edge: Edge) {
    return edge.dedupe_key ?? [edge.kind, edge.target, edge.trigger].map((item) => (typeof item === "string" ? item : "")).filter(Boolean).join(":")
  }

  function key(edge: Edge, src: Source) {
    return edge.dedupe_key ?? [src.agent, edge.kind, edge.target].filter((item): item is string => typeof item === "string" && item.length > 0).join(":")
  }

  function slug(input: string) {
    return input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  }

  function rec(input: unknown): Rec | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
    return input as Rec
  }

  function text(input: unknown) {
    if (typeof input !== "string" || input.trim().length === 0) return undefined
    return input.trim()
  }

  function list(input: unknown) {
    if (typeof input === "string" && input.length > 0) return [input]
    if (!Array.isArray(input)) return []
    return input.filter((item): item is string => typeof item === "string" && item.length > 0)
  }

  function ftext(input: unknown): FailurePolicy | undefined {
    if (input === "block" || input === "continue" || input === "retry" || input === "escalate") return input
    return undefined
  }
}
