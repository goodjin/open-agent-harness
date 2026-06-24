# Child Session Parent Refresh

## User Goal

When a delegated child session is created, the parent timeline should show the child session list immediately without requiring the user to switch away and back.

## Agreed Scope

- Use session events as refresh triggers.
- Treat child `session.created` as a signal that its parent needs a later full refresh.
- Refresh the parent only after the parent `session.updated` event arrives, because that is when `SessionDelegation.assign()` has written `dsl_context.protocol.pending_delegations`.
- Keep the timeline rendering source as the parent session `dsl_context`; do not infer current-turn child rows from bare child session records.

## Affected Modules

- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/context/global-sync.tsx`
- `packages/app/src/context/global-sync/event-reducer.test.ts`
- `docs/harness-module/ui-console.md`

## Implementation Plan

1. Add a reducer test for child-created parent refresh sequencing.
2. Track parent session ids that should be refreshed after a child is created.
3. When the matching parent `session.updated` event arrives, fetch the full parent session and update the session store.
4. Keep existing session tree refresh behavior for child session creation.

## Verification Plan

- Run the focused app event reducer test from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
