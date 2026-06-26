# Session Panel Child Count

## User Goal

The number shown after the right-side `Protocol` tab should represent the actual number of child sessions for the current session. It must not come from the selected protocol run's action count.

## Agreed Scope

- Change the right-side graph/protocol tab badge to count direct child sessions where `parentID` matches the current session id.
- Keep protocol run `completed/total` inside the graph panel itself, where it describes the selected protocol graph.
- Do not change protocol run persistence or action graph semantics.
- Load current-session descendants when a session page opens so direct navigation can still show an accurate child count.

## Affected Modules

- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-children.ts`
- `packages/app/src/pages/session/session-children.test.ts`
- `docs/harness-module/ui-console.md`

## Implementation Plan

1. Add a small helper that filters direct, non-archived child sessions from the synchronized session list.
2. Use that helper in the right-side session panel tab badge.
3. Fetch current-session descendants with `session.descendantsBatch` and merge them into the session store.
4. Add focused unit coverage showing protocol run counts do not affect the child-session count.

## Verification Plan

- Run the focused unit test from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
