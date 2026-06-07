import { describe, expect, test } from "bun:test"
import { AgentObservability } from "../../src/agent/observability"

describe("AgentObservability", () => {
  test("maps standard defaults to control config", () => {
    expect(AgentObservability.policy({})).toEqual({
      trace_level: "summary",
      log_level: "info",
      metrics: true,
      capture_context_summary: true,
      capture_artifact_summary: false,
      redaction_profile: "default",
    })
  })

  test("supports minimal detailed and debug levels", () => {
    expect(
      AgentObservability.policy({
        meta: {
          observability: {
            level: "minimal",
          },
        },
      }),
    ).toEqual({
      trace_level: "summary",
      log_level: "warn",
      metrics: false,
      capture_context_summary: false,
      capture_artifact_summary: false,
      redaction_profile: "strict",
    })

    expect(
      AgentObservability.policy({
        meta: {
          observability: {
            level: "detailed",
          },
        },
      }),
    ).toEqual({
      trace_level: "detailed",
      log_level: "debug",
      metrics: true,
      capture_context_summary: true,
      capture_artifact_summary: true,
      redaction_profile: "default",
    })

    expect(
      AgentObservability.policy({
        meta: {
          observability: {
            level: "debug",
          },
        },
      }),
    ).toEqual({
      trace_level: "debug",
      log_level: "debug",
      metrics: true,
      capture_context_summary: true,
      capture_artifact_summary: true,
      redaction_profile: "relaxed",
    })
  })

  test("privacy sensitive context limits raw capture controls", () => {
    expect(
      AgentObservability.policy({
        meta: {
          observability: {
            level: "debug",
            redaction_profile: "relaxed",
          },
        },
        sensitivity: "privacy-sensitive",
      }),
    ).toEqual({
      trace_level: "detailed",
      log_level: "debug",
      metrics: true,
      capture_context_summary: true,
      capture_artifact_summary: false,
      redaction_profile: "strict",
    })
  })

  test("allows explicit safe overrides without telemetry vocabulary", () => {
    expect(
      AgentObservability.policy({
        observability: {
          level: "standard",
          log_level: "warn",
          metrics: false,
          capture_artifact_summary: true,
          redaction_profile: "team-safe",
        },
      }),
    ).toEqual({
      trace_level: "summary",
      log_level: "warn",
      metrics: false,
      capture_context_summary: true,
      capture_artifact_summary: true,
      redaction_profile: "team-safe",
    })
  })
})
