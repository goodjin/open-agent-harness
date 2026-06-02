export type ObservabilityLevel = "minimal" | "standard" | "detailed" | "debug"

export type ObservabilityInput = {
  meta?: {
    observability?: ObservabilityConfig
  }
  observability?: ObservabilityConfig
  sensitivity?: string
  context?: {
    sensitivity?: string
    privacy?: boolean
  }
}

export type ObservabilityConfig = {
  level?: ObservabilityLevel
  trace?: string
  trace_level?: string
  log?: string
  log_level?: string
  metrics?: boolean
  capture_context_summary?: boolean
  capture_artifact_summary?: boolean
  redaction_profile?: string
}

export type ObservabilityPolicy = {
  trace_level: string
  log_level: string
  metrics: boolean
  capture_context_summary: boolean
  capture_artifact_summary: boolean
  redaction_profile: string
}

export namespace AgentObservability {
  export function policy(input: ObservabilityInput): ObservabilityPolicy {
    const cfg = input.observability ?? input.meta?.observability ?? {}
    const base = preset(cfg.level ?? "standard")
    const out = {
      trace_level: cfg.trace_level ?? cfg.trace ?? base.trace_level,
      log_level: cfg.log_level ?? cfg.log ?? base.log_level,
      metrics: cfg.metrics ?? base.metrics,
      capture_context_summary: cfg.capture_context_summary ?? base.capture_context_summary,
      capture_artifact_summary: cfg.capture_artifact_summary ?? base.capture_artifact_summary,
      redaction_profile: cfg.redaction_profile ?? base.redaction_profile,
    }

    if (!sensitive(input)) return out
    return {
      ...out,
      trace_level: out.trace_level === "debug" ? "detailed" : out.trace_level,
      capture_artifact_summary: false,
      redaction_profile: "strict",
    }
  }
}

function preset(level: ObservabilityLevel): ObservabilityPolicy {
  if (level === "minimal") {
    return {
      trace_level: "summary",
      log_level: "warn",
      metrics: false,
      capture_context_summary: false,
      capture_artifact_summary: false,
      redaction_profile: "strict",
    }
  }
  if (level === "detailed") {
    return {
      trace_level: "detailed",
      log_level: "debug",
      metrics: true,
      capture_context_summary: true,
      capture_artifact_summary: true,
      redaction_profile: "default",
    }
  }
  if (level === "debug") {
    return {
      trace_level: "debug",
      log_level: "debug",
      metrics: true,
      capture_context_summary: true,
      capture_artifact_summary: true,
      redaction_profile: "relaxed",
    }
  }
  return {
    trace_level: "summary",
    log_level: "info",
    metrics: true,
    capture_context_summary: true,
    capture_artifact_summary: false,
    redaction_profile: "default",
  }
}

function sensitive(input: ObservabilityInput) {
  if (input.context?.privacy) return true
  return [input.sensitivity, input.context?.sensitivity].some((item) => {
    if (!item) return false
    return ["privacy-sensitive", "sensitive", "secret", "restricted"].includes(item)
  })
}
