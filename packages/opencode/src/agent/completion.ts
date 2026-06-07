export type CompletionStatus = "completed" | "partial" | "blocked" | "failed" | "waiting_user"

export type CompletionReason = {
  code: string
  message: string
  target?: string
}

export type CompletionItem = {
  id?: string
  name?: string
  target?: string
  type?: string
  status?: string
  required?: boolean
}

export type CompletionGate = CompletionItem

export type CompletionConfig = {
  mode?: string
  criteria?: readonly string[]
  required_artifacts?: readonly string[]
  required_evidence?: readonly string[]
  gates?: readonly CompletionGate[]
  allow_partial?: boolean
  failure_policy?: {
    failed_dependency?: "block" | "fail"
    failed_gate?: "partial" | "fail"
    budget_exhausted?: "partial" | "fail"
  }
}

export type CompletionContext = {
  meta?: {
    completion?: CompletionConfig
    collaboration?: {
      edges?: readonly CompletionItem[]
    }
  }
  completion?: CompletionConfig
  collaboration?: {
    edges?: readonly CompletionItem[]
  }
  dependencies?: readonly CompletionItem[]
  artifacts?: readonly CompletionItem[]
  evidence?: readonly CompletionItem[]
  gates?: readonly CompletionGate[]
  unresolved?: readonly (string | CompletionItem)[]
  validation?: {
    status?: string
    valid?: boolean
    passed?: boolean
    summary?: string
    errors?: readonly string[]
  }
  budget?: {
    status?: string
    exhausted?: boolean
    over?: boolean
    remaining?: number
  }
  failure?: {
    status?: string
    failed?: boolean
    failures?: number
    max_failures?: number
  }
  signals?: {
    done?: boolean
    [key: string]: unknown
  }
}

export type CompletionDecision = {
  status: CompletionStatus
  reasons: CompletionReason[]
  missing_artifacts: string[]
  missing_evidence: string[]
  failed_gates: string[]
  unresolved: string[]
  next: string
}

export function evaluateCompletion(ctx: CompletionContext): CompletionDecision {
  const cfg = ctx.completion ?? ctx.meta?.completion ?? {}
  const unresolved = open(ctx)
  const reasons = [
    ...deps(ctx, cfg),
    ...edges(ctx),
    ...artifacts(ctx, cfg),
    ...evidence(ctx, cfg),
    ...validation(ctx),
    ...gates(ctx, cfg),
    ...unresolved,
    ...limits(ctx, cfg),
  ]
  const missing = reasons.filter((item) => item.code === "missing_artifact").map((item) => item.target ?? "")
  const proof = reasons.filter((item) => item.code === "missing_evidence").map((item) => item.target ?? "")
  const failed = reasons.filter((item) => item.code === "failed_gate" || item.code === "pending_gate").map((item) => item.target ?? "")
  const status = state(reasons, cfg)

  return {
    status,
    reasons,
    missing_artifacts: missing,
    missing_evidence: proof,
    failed_gates: failed,
    unresolved: unresolved.map((item) => item.target ?? item.message),
    next: next(status, reasons),
  }
}

function deps(ctx: CompletionContext, cfg: CompletionConfig) {
  return (ctx.dependencies ?? []).flatMap((item) => {
    if (item.required === false) return []
    if (item.status === "failed") {
      return [
        reason(
          cfg.failure_policy?.failed_dependency === "fail" ? "fatal_dependency" : "failed_dependency",
          "Required dependency failed",
          name(item),
        ),
      ]
    }
    if (done(item.status)) return []
    return [reason("pending_dependency", "Required dependency is not complete", name(item))]
  })
}

function edges(ctx: CompletionContext) {
  return (ctx.collaboration?.edges ?? ctx.meta?.collaboration?.edges ?? []).flatMap((item) => {
    if (item.required !== true) return []
    if (done(item.status)) return []
    if (item.status === "failed") return [reason("failed_dependency", "Required collaboration dependency failed", name(item))]
    return [reason("pending_dependency", "Required collaboration dependency is not complete", name(item))]
  })
}

function artifacts(ctx: CompletionContext, cfg: CompletionConfig) {
  return (cfg.required_artifacts ?? []).flatMap((item) => {
    if (available(ctx.artifacts, item)) return []
    return [reason("missing_artifact", "Required artifact is missing", item)]
  })
}

function evidence(ctx: CompletionContext, cfg: CompletionConfig) {
  return (cfg.required_evidence ?? []).flatMap((item) => {
    if (available(ctx.evidence, item)) return []
    if (available(ctx.artifacts, item)) return []
    return [reason("missing_evidence", "Required evidence is missing", item)]
  })
}

function validation(ctx: CompletionContext) {
  if (!ctx.validation) return []
  if (ctx.validation.status === "passed" || ctx.validation.valid === true || ctx.validation.passed === true) return []
  if (ctx.validation.status === "failed" || ctx.validation.valid === false || ctx.validation.passed === false) {
    return [
      reason(
        "output_validation_failed",
        ctx.validation.summary ?? ctx.validation.errors?.[0] ?? "Output validation failed",
        "output",
      ),
    ]
  }
  return [reason("output_validation_pending", "Output validation is not complete", "output")]
}

function gates(ctx: CompletionContext, cfg: CompletionConfig) {
  return (cfg.gates ?? []).flatMap((item) => {
    if (item.required === false) return []
    const gate = ctx.gates?.find((val) => name(val) === name(item)) ?? item
    if (gate.status === "passed" || gate.status === "completed" || gate.status === "satisfied") return []
    if (gate.status === "failed") return [reason("failed_gate", "Required gate failed", name(item))]
    return [reason(item.type === "human" || gate.type === "human" ? "pending_gate" : "failed_gate", "Required gate is not satisfied", name(item))]
  })
}

function open(ctx: CompletionContext) {
  return (ctx.unresolved ?? []).map((item) => {
    if (typeof item === "string") return reason("unresolved", "Unresolved item remains", item)
    return reason("unresolved", "Unresolved item remains", name(item))
  })
}

function limits(ctx: CompletionContext, cfg: CompletionConfig) {
  return [
    budget(ctx, cfg),
    failure(ctx),
  ].filter((item): item is CompletionReason => item !== undefined)
}

function budget(ctx: CompletionContext, cfg: CompletionConfig) {
  if (!ctx.budget?.exhausted && !ctx.budget?.over && ctx.budget?.status !== "exhausted" && ctx.budget?.remaining !== 0) return undefined
  return reason(cfg.failure_policy?.budget_exhausted === "fail" ? "fatal_budget" : "budget_exhausted", "Completion budget is exhausted", "budget")
}

function failure(ctx: CompletionContext) {
  if (ctx.failure?.failed === true || ctx.failure?.status === "failed") return reason("failure_policy", "Failure policy marked the task failed", "failure")
  if (ctx.failure?.max_failures === undefined || ctx.failure.failures === undefined) return undefined
  if (ctx.failure.failures < ctx.failure.max_failures) return undefined
  return reason("failure_policy", "Failure policy limit was reached", "failure")
}

function state(reasons: readonly CompletionReason[], cfg: CompletionConfig): CompletionStatus {
  if (reasons.some((item) => item.code === "fatal_dependency" || item.code === "fatal_budget" || item.code === "failure_policy" || item.code === "output_validation_failed")) return "failed"
  if (reasons.some((item) => item.code === "failed_dependency" || item.code === "pending_dependency")) return "blocked"
  if (reasons.some((item) => item.code === "pending_gate")) return "waiting_user"
  if (!reasons.length) return "completed"
  if (cfg.allow_partial === false && reasons.some((item) => item.code === "failed_gate")) return "failed"
  return "partial"
}

function next(status: CompletionStatus, reasons: readonly CompletionReason[]) {
  if (status === "completed") return "complete"
  if (status === "waiting_user") return "wait_for_user"
  if (reasons.some((item) => item.code === "failed_dependency" || item.code === "pending_dependency" || item.code === "fatal_dependency")) return "resolve_dependencies"
  if (reasons.some((item) => item.code === "missing_artifact")) return "produce_missing_artifacts"
  if (reasons.some((item) => item.code === "missing_evidence")) return "collect_missing_evidence"
  if (reasons.some((item) => item.code === "output_validation_failed" || item.code === "output_validation_pending")) return "fix_output_validation"
  if (reasons.some((item) => item.code === "failed_gate")) return "satisfy_gates"
  if (reasons.some((item) => item.code === "unresolved")) return "resolve_unresolved"
  return status === "failed" ? "stop" : "continue"
}

function available(values: readonly CompletionItem[] | undefined, target: string) {
  return (values ?? []).some((item) => name(item) === target && (item.status === undefined || done(item.status)))
}

function done(status: string | undefined) {
  return status === "completed" || status === "passed" || status === "available" || status === "satisfied"
}

function name(item: CompletionItem) {
  return item.name ?? item.id ?? item.target ?? ""
}

function reason(code: string, message: string, target?: string): CompletionReason {
  return {
    code,
    message,
    ...(target ? { target } : {}),
  }
}
