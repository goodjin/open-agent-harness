# Workflow Runner Test Isolation

## User Goal

Make Workflow-related SessionRunner tests deterministic and prevent unfinished asynchronous work from leaking into later tests.

## Agreed Scope

- Replace the fixed 10ms progress assumption with an observable synchronization point.
- Ensure every started `runner.process()` promise is awaited or safely settled before mocks are restored.
- Prevent the `waiting` workflow fixture from falling through to the real Workflow loader after test failure.
- Make `workflow runner persists and runs workflow returned by chat` pass both alone and after the progress test.
- Do not change production Workflow behavior unless a concrete production defect is required to make deterministic synchronization possible.

## Implementation Plan

1. Rework the active-workflow progress test around explicit barriers rather than wall-clock sleep.
2. Keep the `continueRun` mock installed until the pending runner promise settles.
3. Add a paired or grouped verification that runs the progress and persisted-workflow tests together.
4. Check nearby Workflow SessionRunner tests for leaked promises or mocks.
5. Update module documentation only if production behavior changes.

## Affected Modules

- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/src/session/runner.ts` only if deterministic synchronization requires a production correction
- `docs/harness-module/workflow-runtime.md` or the existing matching module document only if production behavior changes

## Verification Plan

- Run the active-workflow progress test independently.
- Run it together with the persisted-generated-workflow test.
- Run all Workflow-filtered SessionRunner tests.
- Run `bun typecheck` from `packages/opencode`.

