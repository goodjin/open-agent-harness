# Timeline Confirm Parent Match

## User Goal

Protocol `confirm` gates should render in the session timeline where the related turn is displayed. A session can show `waiting_user` while no confirmation card appears; that leaves the user unable to confirm or cancel from the intended timeline surface.

## Agreed Scope

- Keep protocol confirmations as timeline UI.
- Fix the turn-matching path that decides whether a persisted confirmation belongs to a rendered user turn.
- Preserve existing question dock layout and duplicate suppression behavior.
- Do not move confirmations into the composer fallback as part of this fix.

## Implementation Plan

1. Update the shared session turn matcher used by delegation and confirmation rows.
2. Prefer the durable `assistant.parentID === user.id` relationship before falling back to contiguous message ordering.
3. Add a regression test for a late assistant message that arrives after the next user message but still belongs to the original turn.

## Affected Modules

- `packages/app/src/pages/session/session-delegations.ts`
- `packages/app/src/pages/session/session-delegations.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run the focused session delegation test from `packages/app`.
- Run app typecheck from `packages/app`.
- Run the lightweight app smoke check from `packages/app`.
