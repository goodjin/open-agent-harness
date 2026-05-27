# Action And Executor Contract

## Purpose

This document defines the executable unit in Harness.

Every model request, tool call, delegated agent task, runtime operation, human approval, pipeline, or service invocation that can change execution state must be normalized into an `Action` before execution. The runtime may accept different model-facing carriers, but the internal execution path must be the same.

## Core Rule

Tool calls are not the protocol boundary. They are one possible carrier.

The protocol boundary is:

```txt
model intent -> normalized Action -> policy checks -> executor invocation -> result -> event/projection
```

Accepted carriers:

- native Harness DSL declaration
- `AgentProtocolOutput` or equivalent runtime-owned toolCall carrier
- safe recovery from direct tool requests
- safe recovery from task/delegation requests

Recovered actions must be marked with `origin.kind: "recovered"` so logs and evaluation can distinguish explicit protocol output from recovered protocol input.

## Action Shape

Recommended internal action fields:

```json
{
  "id": "read_package",
  "type": "action",
  "operation": "read",
  "title": "Read package manifest",
  "description": "Read package.json from the current project.",
  "origin": {
    "kind": "protocol_tool_call",
    "message_id": "msg_123",
    "source_id": "call_123"
  },
  "executor": {
    "type": "tool",
    "target": "read_file",
    "capabilities": ["filesystem.read"]
  },
  "args": {
    "path": "package.json"
  },
  "resources": {
    "read": ["file:package.json"],
    "write": []
  },
  "side_effects": ["read"],
  "depends_on": [],
  "permission_policy": {
    "mode": "inherit"
  },
  "budget_policy": {
    "timeout_ms": 120000
  },
  "result_policy": {
    "return_to_model": "summary",
    "store_full": true
  },
  "data_visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "future_runs": "ref"
  },
  "idempotency": "safe_retry",
  "cancellation": "best_effort"
}
```

Required v1 fields:

- `id`
- `type`
- `operation`
- `executor.type`
- `executor.target`
- `args`
- `side_effects`
- `result_policy`
- `origin`

## Executor Types

Runtime-supported executor classes:

| Type | Meaning | v1 stance |
|---|---|---|
| `tool` | Bounded tool or MCP tool | Supported for read-only actions first. |
| `agent` | Delegated LLM session | Supported after routing and child-session trace are stable. |
| `runtime` | Harness-owned operation such as summarize, checkpoint, merge, wait | Supported for safe operations. |
| `human` | User/Owner clarification, approval, or decision | Representable in schema; execution depends on UI/API support. |
| `pipeline` | Predefined deterministic multi-step procedure | Later. |
| `service` | External integration | Later and approval-gated. |

## ToolCall Recovery

When a model emits a direct tool request, runtime may recover it into an action only if:

- the tool maps to exactly one executor target
- the arguments validate against that executor schema
- side effects can be classified
- permission policy is known
- result policy can default safely
- execution does not bypass disabled agent/tool policy

Unsafe recovery must fail closed.

Examples:

- `read_file({ path: "package.json" })` can recover to `operation: "read"`.
- `bash({ command: "rm -rf dist" })` must not auto-run; it requires explicit side effect classification and approval.
- `task({ description: "fix it" })` is too vague unless the target agent, scope, and expected result can be derived safely.

## Lifecycle

Action lifecycle events:

```txt
action.accepted
action.blocked
action.started
action.executor_selected
action.permission_requested
action.permission_resolved
action.output_stored
action.completed
action.failed
action.cancelled
```

Every terminal action result should include:

- `status`
- `summary`
- `artifacts`
- `logs_ref`
- `error` when failed or blocked
- `visibility` summary of what was replayed to the model

## V1 Boundary

The first implementation should support:

- `tool` executor for search/read/summarize-style actions
- `runtime` executor for safe aggregation and protocol bookkeeping
- side-effect blocking by default
- concise model-visible result with full logs/artifacts stored separately
- recovery only for low-risk read-only tool calls
