# Evaluation and Observability

MOD-15 adds focused checks for audit, metrics, traces, regression, performance, and provider failure modes.

## Audit

Audit records are sanitized and explicit. They cover permission decisions, checkpoint restores, workflow lifecycle changes, and memory capture. Query them with:

```sh
bun test test/server/audit.test.ts
```

The route is `GET /audit` and supports `sessionID`, `projectID`, and `eventType` filters. Workspace and project isolation are enforced by the current server context.

## Metrics

Metrics are in-process samples with stable names:

- `opencode_agent_load_total`
- `opencode_agent_load_duration_ms`
- `opencode_permission_evaluation_total`
- `opencode_tool_call_total`
- `opencode_tool_call_duration_ms`
- `opencode_session_lifecycle_total`

## Traces

Prompt loops create a `session.prompt.loop` span. Tool calls create child `tool.call` spans when they execute inside the prompt loop context.

## Performance Targets

Local timed checks use conservative thresholds:

- `agent_loader_ms`: 250 ms
- `session_create_ms`: 150 ms
- `permission_eval_ms`: 25 ms

These checks are intended to catch accidental large regressions, not benchmark machine-to-machine variance.

## Phase Gate

Run from `packages/opencode`:

```sh
bun run gate:mod15
```

For API route changes, regenerate the SDK from the repository root:

```sh
./packages/sdk/js/script/build.ts
```
