# Context, Memory, And Visibility Policy

## Purpose

This document defines how Harness controls what information agents receive, what is stored, what is replayed to the model, and what is visible to users.

## Core Rule

Runtime shapes context. Agents should not receive full raw transcripts by default.

```txt
Projection + Memory Service + Artifact refs -> Context Bundle -> Assignment
```

## Context Bundle

An assignment context bundle should include:

```json
{
  "id": "ctx_123",
  "goal": "Review the changed protocol schema.",
  "included": [
    "file:docs/harness-protocol/03-model-runtime-protocol.md",
    "artifact:protocol_diff"
  ],
  "excluded": [
    "raw transcripts from unrelated child sessions",
    "superseded memory records"
  ],
  "summary": "The protocol supports toolCall carriers and runtime recovery.",
  "memory_refs": ["mem_protocol_v1_policy"],
  "projection_refs": ["runtime://runs/run_123/projections/task-state"]
}
```

## Memory Scope

Memory records must declare scope:

- `run`
- `project`
- `team`
- `global`

Scope precedence must be explicit. Current Projection overrides historical memory. Project memory may override team/global preferences inside the project scope.

## Data Visibility

Every action result should classify visibility:

| Channel | Meaning |
|---|---|
| `model` | Replayed into future model context. |
| `user` | Displayed in UI or final answer. |
| `logs` | Stored for audit/export. |
| `future_runs` | Available as memory/reference for later runs. |
| `runtime_only` | Used for control decisions but not exposed by default. |

Default policy:

- model receives summaries and refs
- user receives concise progress/result projection
- logs store full structured trace subject to redaction
- future runs receive curated memory, not raw logs

## Result Granularity

Allowed return modes:

- `summary`
- `structured`
- `full`
- `on_failure`
- `on_demand`
- `adaptive`

Runtime may reduce the model-visible result below the requested granularity for privacy, safety, or context budget reasons. Runtime may not increase visibility beyond policy.

## Privacy And Redaction

Before replaying or exporting data, runtime should check:

- secrets
- credentials
- private keys
- personal data
- proprietary external content
- raw command output containing sensitive paths or tokens

Redaction policy must apply consistently to tool output, protocol logs, workflow artifacts, and UI exports.

## Shell And Automatic Actions

Automatic shell execution records may be visible in UI while ignored in model context by default. This behavior is aligned with Harness context isolation: visible timeline output is not automatically model-visible context.

If the user explicitly adds shell output to context, runtime should create a normal context record with source refs and visibility metadata.

## V1 Boundary

V1 should implement:

- context bundle refs rather than full transcript replay
- concise protocol result replay
- full output stored as artifacts/logs
- explicit `ignored` or equivalent metadata for non-model-visible UI records
- memory query results with scope, namespace, status, and evidence refs
