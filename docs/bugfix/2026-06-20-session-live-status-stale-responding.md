# Bug Fix: Session Live Status Stays Responding After Turn Completion

## Problem

- Date: 2026-06-20
- Severity: Medium
- Scope: session composer live status on the app session page

After a conversation turn ended, the session area could still show the model as responding.

## Root Cause

- Location: `packages/app/src/pages/session/helpers.ts`
- Cause: `deriveSessionLiveStatus()` used any unfinished assistant message as a live-response signal before checking whether the session or latest user turn had already ended.

The runtime already exposes completion through `session.status` and user-message `metadata.turn.status`. The UI fallback for streamed assistant parts did not respect those completion signals, so stale local message cache entries could keep the composer status line in a responding state.

## Fix

- Return no live status for `idle`, `completed`, `user_completed`, and `archived` sessions.
- Only use unfinished assistant parts to derive responding, thinking, text, and tool labels while `session.status.type === "running"`.
- Suppress the generic running/responding line when the latest user turn metadata is already `done`.
- Added regression coverage for stale unfinished assistant messages after session completion and for running sessions whose latest turn is already done.

## Verification

1. Passed: `bun test src/pages/session/helpers.test.ts` from `packages/app`
2. Passed: `bun typecheck` from `packages/app`
3. Passed: `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`

## Related Documentation

- `docs/features/2026-06-20-session-live-status-turn-completion.md`
- `docs/harness-module/ui-console.md`
