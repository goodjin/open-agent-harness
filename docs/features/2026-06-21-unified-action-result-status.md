# Unified ActionResult Status

## User Goal

Unify `ActionResult.status` across worker and verifier results so identical field names have identical semantics. A verifier result must not be rejected because runtime selected a worker-specific status schema.

## Agreed Scope

- Use one model-facing status set for all `ActionResult` calls: `success`, `failure`, `error`, `reply`, and `skipped`.
- Treat verifier `success` as the previous `pass`, and verifier `failure` as the previous `fail`.
- Keep compatibility for old `pass` and `fail` inputs by normalizing them at parse time.
- Keep worker/verifier routing based on result shape and stored role, not on separate status enums.
- Keep all descriptive fields as plain strings.

## Implementation Plan

1. Update `packages/opencode/src/session/action-result.ts` so worker and verifier inputs share the same status definition.
2. Normalize legacy `pass` / `fail` values before storing or routing results.
3. Update verifier gate routing to use unified `success` / `failure` semantics.
4. Update delegated prompts, request-footer examples, and protocol documentation to describe one status set.
5. Update focused tests for parser compatibility, protocol text, and gate routing behavior.

## Affected Modules

- `packages/opencode/src/session/action-result.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/request-footer.ts`
- `packages/opencode/test/session/*`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-protocol/09-ui-console-and-agent-management.md`

## Verification Plan

- Run focused ActionResult parser tests.
- Run focused delegation and runner tests for verifier gate behavior.
- Run `bun typecheck` from `packages/opencode`.
