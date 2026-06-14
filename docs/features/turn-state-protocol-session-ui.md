# Turn State, Protocol Outcomes, and Session UI

## Goal

Fix delegated-result and queued-message handling by introducing an explicit request turn state. A turn represents one user or runtime-generated prompt request. A turn is done when the request has reached a runtime-defined boundary, not when the whole session is finished.

## Agreed Semantics

- `turn.done` means the current prompt request has settled.
- `waiting_user` and `waiting_child` are done outcomes for the current turn.
- Session status still represents the broader session state, such as waiting for the user or child sessions.
- `AgentProtocolOutput` is not enough by itself to mark a turn done. The protocol package must be parsed and executed to a runtime boundary.
- Protocol tool-call style actions can remain in the same turn until the runtime reaches a reply, wait, blocked, failed, or delegated-child boundary.
- `ActionResult` is not done when the model merely calls the tool. It becomes done when the runtime accepts, records, and routes the result.
- Assistant completion remains a compatibility marker for non-protocol agents and old messages.
- Queued user messages should be consumed in order after the previous turn reaches a done state. User-originated queued messages take precedence over runtime-generated continuation messages.

## Implementation Plan

1. Add a turn-state helper for reading and writing turn metadata on user messages.
2. Mark user messages as queued at creation, running when the prompt loop starts processing them, and done when runtime or assistant completion settles the request.
3. Update the prompt loop to choose the earliest non-done user turn instead of the latest user message.
4. Clear resolved callbacks and stale session loop state when no queued turn remains.
5. Mark protocol turns done only after protocol execution reaches a runtime boundary.
6. Mark delegated action turns done after `ActionResult`/delegation completion is accepted and routed.
7. Update session UI helpers to use turn metadata with assistant completion as compatibility fallback.
8. Improve the visible request-end summary with tool counts, child-session counts, protocol-action counts, confirmations, and duration.
9. Refine timeline rendering so thinking, text, tool, protocol, and confirmation states reflect actual part state.
10. Compact and format confirmation cards so long text does not overflow.

## Affected Modules

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/app/src/pages/session/*`
- `packages/app/src/pages/layout/helpers.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run focused backend session tests from `packages/opencode`.
- Run focused app helper/timeline tests from `packages/app`.
- Run `bun typecheck` in `packages/opencode`.
- Run `bun typecheck` in `packages/app`.
- Run app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
