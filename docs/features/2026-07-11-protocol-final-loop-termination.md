# Protocol Final Loop Termination

## User Goal

Ensure Agent Protocol final-response recursion always reaches a bounded terminal state. Repeated runtime packages, distinct follow-up packages, plain final fallback, and the soft runtime limit must not leave `SessionRunner.process()` pending indefinitely.

## Agreed Scope

- Diagnose and fix the four independently reproducible final-loop timeout scenarios in `runner.test.ts`.
- Preserve support for bounded follow-up execution when each package adds useful work.
- Stop exact or semantically equivalent repeated packages through the loop guard.
- Preserve one retry for a missing native final response, followed by a bounded plain-response fallback or explicit malformed result.
- Keep changes limited to final-response recursion, counters, termination, and focused tests.
- Do not migrate unrelated parser fixtures or Workflow tests in this work package.

## Implementation Plan

1. Trace every recursive `final()` entry and identify which branch fails to settle.
2. Make retry, missing-tool, execution-follow-up, and soft-limit counters explicit and monotonic across recursion.
3. Guarantee every branch either returns a terminal response or performs one bounded recursive step.
4. Add or update focused tests for plain fallback, repeated execution, distinct follow-ups, and soft limit.
5. Document final-loop bounds in the protocol runtime module documentation.

## Affected Modules

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the four final-loop tests with the normal 5-second timeout.
- Run nearby final-response and plain-result tests.
- Run `bun typecheck` from `packages/opencode`.

