# Delegation Live Child Status and Manual Submit

## Goal

Fix delegated parent session behavior so child sessions are visible as soon as they are created, their status stays live in the session timeline, and the parent receives one aggregate handoff after the delegated run is ready instead of one reply per child session.

## Agreed Scope

- Show the child session list for the current turn as soon as pending delegated assignments exist.
- Track child session status from the live session status store.
- Keep ended child sessions openable so users can inspect their results.
- Hide the generic continue action for ended child sessions.
- Show restore only for interrupted child sessions.
- Notify the parent model only after all sibling child sessions in the run have ended.
- Add a child-list action that manually submits the current child results and statuses to the parent session.
- Let manual submit unblock the parent when one or more child sessions ended without a structured result.

## Implementation Plan

1. Add a reusable runtime submit path in `SessionDelegation` that closes terminal pending children into synthetic results and prompts the parent with the aggregate Markdown handoff.
2. Keep automatic notification gated by run readiness and the existing notified-run claim.
3. Expose a server route for manually submitting delegation results for a parent session and run.
4. Extend the session timeline child list to show live states, open ended results, hide continue for ended sessions, restore only interrupted sessions, and add the manual submit button.
5. Update module docs for protocol runtime and session UI behavior.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/pages/session/session-delegations.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run focused `SessionDelegation` tests from `packages/opencode`.
- Run focused session delegation UI helper tests from `packages/app`.
- Run `bun typecheck` from affected package directories.
- Run the lightweight app smoke test from `packages/app` because this touches the session timeline UI.
