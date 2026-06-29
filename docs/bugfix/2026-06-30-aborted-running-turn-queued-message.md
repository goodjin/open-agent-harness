# Bug Fix: Aborted Running Turn Blocks Queued Messages

## Problem

- Date: 2026-06-30
- Severity: High
- Scope: session prompt loop, queued user messages, session timeline controls

When a running session is aborted and the current assistant message is left as an unfinished empty shell, the parent user turn can remain in `metadata.turn.status = "running"`. A later user message is persisted as `queued`, but the prompt loop selects the older running turn first, so the new message stays queued and future sends replay the older turn.

Observed session:

- `ses_0ed3da70cffeflpETMy3w9pUkJ`
- title: `M-2 Phase 15 Marketplace Ship-Ready`
- stale running user: `msg_f13cb6d9d001Vqq5lJC72DInhu`
- queued user: `msg_f13cde9c5001O7SlWP7uE8vADd`

## Root Cause

`SessionPrompt.turn()` selects the first unfinished non-internal user turn. `SessionPrompt.repair()` only closes a stale running user turn when `closed()` finds a completed assistant or an assistant with a persisted error. Abort logs can record `MessageAbortedError` while the assistant row remains an unfinished empty shell, so repair does not close the old turn and the queued follow-up is starved.

The queue cancellation route already exists, but the visible behavior is confusing when the blocking item is an old `running` turn and not the queued row itself.

## Fix

- Add a regression test for `running user + aborted empty assistant + later queued user`.
- Make prompt-loop repair close stale aborted assistant shells so the next queued user can run.
- Persist an aborted assistant shell as `MessageAbortedError`, `finish=error`, and `time.completed` when a later user message already exists.
- Keep queued-message deletion limited to `role=user` and `turn.status=queued`.
- Leave the existing timeline queued-message delete route and composer follow-up cancel path unchanged.

## Affected Modules

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/message-timeline.test.ts`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-console.md`

## Verification

1. `bun test test/session/prompt.test.ts -t "loop skips aborted running turns before processing queued user turns"` failed before the runtime fix with `Session loop ended before this prompt produced a response.`
2. `bun test test/session/prompt.test.ts -t "loop skips aborted running turns before processing queued user turns"` passed after the runtime fix.
3. `bun test test/session/prompt.test.ts -t "loop repairs stale running turns before processing queued user turns|loop skips aborted running turns before processing queued user turns"` passed.
4. `bun test test/session/prompt.test.ts test/server/session-messages.test.ts` passed: 25 tests, 0 failures.
5. `bun typecheck` passed in `packages/opencode`.

No frontend source changed, so the app smoke check was not required for this fix.
