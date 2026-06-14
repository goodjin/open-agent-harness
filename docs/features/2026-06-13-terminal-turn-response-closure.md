# Terminal Turn Response Closure

## User Goal

Prevent a completed user turn from being submitted to the model repeatedly after the model has already returned a complete response.

## Agreed Scope

- Treat assistant terminal responses as turn-closing events before continuing loop work.
- Preserve normal continuation for tool calls, compaction, pending user input, permission gates, and delegated child work.
- Add a regression test that covers a completed text response that would otherwise be looped again.
- Keep the change scoped to session prompt/processor turn handling.

## Implementation Plan

1. Add a test for a terminal assistant response that is complete even if the processor returns `continue`.
2. Update prompt/processor handling so `finish=stop` without pending action closes the current user turn.
3. Keep ActionResult and structured output closure behavior intact.
4. Verify with the focused session prompt test and package typecheck if feasible.

## Affected Modules

- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/test/session/prompt-runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the new focused prompt-runner regression test from `packages/opencode`.
- Run the relevant session prompt test file if the focused test passes.
- Run `bun typecheck` from `packages/opencode` when the focused tests are stable.
