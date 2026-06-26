# 2026-06-26 Session List Blank After Status Authority

## Goal

Fix the blank session list after restarting with the new DB-backed session status fields.

## Scope

- Treat legacy `active/active` rows as idle instead of restart-lost running sessions.
- Persist new active substates with explicit `queued`, `starting`, and `running` status values.
- Repair missing `session_event_outbox` tables when the previous migration was recorded but partially applied.
- Add a focused regression test for legacy active rows.

## Verification

- Run focused session status tests from `packages/opencode`.
- Run focused delegation tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode` and `packages/app`.
- Run app smoke from `packages/app`.
