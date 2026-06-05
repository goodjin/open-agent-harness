# Plan: M10-M11 (M10 in feat/v2-m10-performance, M11 in feat/v2-m11-team-sdk-eval)

## M10 Scope
- Add Harness performance model helpers for bounded data path behavior.
- Add run-level performance summary route and scheduler metrics exposure.
- Add tests for high-volume event pagination, capacity thresholds, and scheduler metrics.

## M11 Scope
- Add team/runtime boundary knobs (backend mode) and trace export endpoint for evaluation use.
- Add governance-oriented permissions metadata endpoint.
- Regenerate OpenAPI + SDK surface for new endpoints.
- Add tests validating SDK-facing contract entries and endpoint payloads.

## Execution order
1. Add failing tests for performance profile + event pagination (M10).
2. Implement `HarnessRuntime.performance` + `Scheduler.metrics` + route and docs wiring.
3. Add failing tests for team backend config + trace export.
4. Implement team/eval route handlers and module helpers.
5. Regenerate SDK types from OpenAPI and run package typecheck/tests.
6. Update v2 docs for capacity and evaluation/permission behavior clarifications.
