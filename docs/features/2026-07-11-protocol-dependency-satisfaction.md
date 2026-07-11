# Protocol Dependency Satisfaction

## User Goal

Make Agent Protocol dependencies run only after their upstream actions have produced satisfying results. A failed ordinary action or a completed-but-non-satisfying historical child result must not unlock downstream work.

## Agreed Scope

- Distinguish action termination from dependency satisfaction in `AgentProtocolExecutor`.
- Do not add failed ordinary actions to the dependency-satisfied set.
- Validate historical dependencies against canonical `SessionResult.satisfying` data.
- Keep the existing same-run delegated fan-in behavior, which already uses `satisfying`.
- Preserve explicit Workflow error-policy behavior; do not refactor the Workflow scheduler in this work package.
- Add focused regression tests for ordinary failures and historical non-satisfying results.

## Implementation Plan

1. Update protocol execution dependency bookkeeping so only successful or policy-approved results satisfy downstream edges.
2. Change historical dependency lookup to use canonical result records and require `satisfying === true`.
3. Preserve compatibility for historical projections only when they carry an explicit satisfying marker; do not infer satisfaction from `status: completed` alone.
4. Add focused executor and runner/delegation regression coverage.
5. Update the protocol runtime module documentation with the resulting dependency contract.

## Affected Modules

- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/delegation.ts` if a narrowly scoped query helper is needed
- `packages/opencode/test/protocol/executor.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run the focused executor dependency tests.
- From `packages/opencode`, run the focused historical dependency runner tests.
- From `packages/opencode`, run `bun typecheck`.

