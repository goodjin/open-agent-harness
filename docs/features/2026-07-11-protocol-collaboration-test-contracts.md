# Protocol Collaboration Test Contracts

## User Goal

Bring three stale SessionRunner collaboration tests in line with the current Agent Protocol runtime contract without weakening production behavior.

## Agreed Scope

- Update child-result fixtures to emit native `ActionResult` values where satisfaction is required.
- Align verifier timing expectations with the current worker-result and verification-gate lifecycle.
- Use an explicitly available mocked agent instead of relying on the hidden, non-delegable built-in `backend` entry.
- Keep legacy `kind: "act"` parser compatibility coverage where it remains intentional.
- Do not change production code solely to satisfy stale expectations.
- Do not change dependency satisfaction semantics owned by the separate dependency work package.

## Implementation Plan

1. Repair the historical verifier test fixture so it represents a canonical satisfying historical result and a native verifier result.
2. Rewrite the verifier lifecycle test to assert verifier launch after a satisfying worker handoff, not before worker completion.
3. Mock an explicitly delegable worker for the child-session test while preserving its model inheritance and parent-resume assertions.
4. Run the three targeted tests and nearby collaboration tests.
5. Update protocol runtime documentation only if the tests reveal an undocumented current contract.

## Affected Modules

- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md` only if needed

## Verification Plan

- From `packages/opencode`, rerun the original three-test command and require `3 pass / 0 fail`.
- From `packages/opencode`, run nearby SessionRunner collaboration tests affected by shared fixtures.
- From `packages/opencode`, run `bun typecheck`.
