# Bug Fix: ActionResult handoff authority

## Problem

- Date: 2026-06-26
- Severity: High
- Scope: delegated child session result storage, status projection, and restart recovery.

A delegated child can produce a valid `ActionResult` with `status: "reply"`, but later runtime paths can project the result as `completed` or resume the already-finished child. The visible symptom is a child session that has a canonical `session_result`, while the session row or child delegation projection looks active, idle, or completed.

## Root Cause

- `SessionDelegation.event()` passes message-finish status into `complete()` for assigned children. For `finish: "tool-calls"`, this forces `completed` even when the terminal `ActionResult` says `reply`.
- `SessionDelegation.notified()` rewrites `protocol.delegation` from the original assignment and can drop `result_id`, `status`, and `completed_at` written by `store()`.
- `SessionStatus.restore()` only repairs `waiting_child` from child status rows. It does not treat an existing child `dsl_context.result` / canonical delegation result as terminal authority, so a completed delegated child can be auto-continued after restart if its status row drifted to active/interrupted.

## Fix Plan

1. Make `ActionResult` / `AgentProtocolOutput` terminal payloads the authoritative status source for assigned children.
2. Preserve stored child result projection fields when adding `notified_at`.
3. Teach status restore to recover terminal delegated child status from `dsl_context.result` when the session row is stale.
4. Add regression tests for verifier `ActionResult(reply)` and message event completion.

## Implementation

- `packages/opencode/src/session/delegation.ts`
  - Assigned-child message events no longer pass message-finish `completed` into `complete()` when a terminal tool part exists.
  - Already-notified handoffs are not re-stored unless a later child message represents a new result round.
  - Child `protocol.delegation` notification preserves stored result projection fields.
- `packages/opencode/src/session/status.ts`
  - Restore and lazy load recover terminal delegated child status from `dsl_context.result`.
  - A later user message than `result.completed_at` prevents stale result recovery.
- `packages/opencode/test/session/delegation.test.ts`
  - Covers idempotent `ActionResult(reply)` projection and the `MessageV2.Event.Updated` completion path.
- `packages/opencode/test/session/status.test.ts`
  - Covers terminal result recovery before restart interruption and the later-user-turn guard.
- `docs/harness-module/protocol-runtime.md`
  - Records the carrier-status authority and restart recovery contract.

## Verification

- ✅ `bun test test/session/delegation.test.ts -t "ActionResult event keeps reply status authoritative|worker ActionResult reply is a terminal non-satisfying handoff"`
- ✅ `bun test test/session/status.test.ts -t "ActionResult"`
- ✅ `bun test test/session/delegation.test.ts`
- ✅ `bun test test/session/status.test.ts`
- ✅ `bun typecheck`
