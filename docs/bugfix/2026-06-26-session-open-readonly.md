# Session Open Should Be Read-Only

## Problem

Opening `Protocol: f5_2_release_notes_runbook_verifier (@release-runner-verifier)` felt slow because the message-read endpoint triggered protocol recovery. The session was interrupted with an incomplete assistant turn, so loading messages started a new model request instead of only returning persisted history.

## Root Cause

`GET /session/:sessionID/message` called `SessionRunner.recover({ sessionID })` before serving messages. That made a read endpoint mutate runtime state and potentially start `SessionPrompt.loop()` / LLM work.

Bootstrap already owns safe automatic continuation:

- `SessionStatus.restore()` restores DB lifecycle state.
- `SessionRecovery.mark()` detects stale tool parts.
- `InstanceBootstrap()` resumes only states accepted by `revive(status, stale)`.

The message endpoint should not be a fallback bootstrap path.

## Fix

- Remove protocol recovery scheduling from the message-read route.
- Keep explicit resume/restore flows unchanged.
- Add a route regression test that verifies message reads do not invoke `SessionRunner.recover()`.

## Open-Session Side Effects To Watch

After the main session area is ready, the UI may still load side-panel data:

- descendants batch for child/session tree badges;
- session logs for the Log/Protocol side panel;
- diff summaries for Review;
- expanded diff detail only when a specific diff is opened.

These should remain bounded reads and must not start model execution.
