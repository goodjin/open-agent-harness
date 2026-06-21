# Protocol Unavailable Agent Failure

## User Goal

When a protocol action targets an unavailable agent such as the removed `hephaestus`, the dispatch should fail clearly. The parent session must not remain or re-enter `waiting_child` unless the current run actually has a live child session to wait for.

## Agreed Scope

- Treat unavailable or denied protocol agent dispatch as a failed action, not a blocked wait.
- Do not restore legacy agents such as `hephaestus`.
- Keep recoverable runtime waits, including user input, confirmations, dependency waits, and metadata prerequisites, as `blocked` or wait states.
- Prevent stale pending child records from older runs from making a later failed turn display as waiting for children.

## Implementation Plan

- Update protocol delegation failure metadata so unavailable and denied agents produce failed protocol actions.
- Update prompt finish waiting logic to count only live pending children and clean ended pending delegation records before writing `waiting_child`.
- Add regression coverage for unavailable agent dispatch and stale interrupted pending children.
- Update the protocol runtime module document with the failure and wait-state distinction.

## Affected Modules

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run the focused session runner test for protocol delegation failure.
- From `packages/opencode`, run `bun typecheck`.
