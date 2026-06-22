# Bug Fix: ActionResult Fallback Parent Summary

## Problem

- Date: 2026-06-22
- Severity: Medium
- Scope: delegated child sessions that fail native `ActionResult` handoff

A delegated child can complete useful work but fail to submit native `ActionResult`. When a later wrapper error such as `ConflictError` reaches delegation failure handling, the parent-visible child result can show only that wrapper error instead of a useful task result summary.

## Root Cause

- Location: `packages/opencode/src/session/delegation.ts`
- `SessionDelegation.fail()` previously decided whether to run automatic fallback summary by checking only the thrown error string.
- If the thrown error was a wrapper such as `ConflictError`, it did not match the `ActionResult` failure detector even when the child transcript contained failed `ActionResult` tool parts.
- The parent-visible result could therefore become the wrapper error.

## Fix

- Extract latest failed `ActionResult` evidence from the child transcript independently from the wrapper error.
- Use that evidence to decide whether automatic fallback summary should run.
- Redesign the summary prompt to produce task-result handoff content only:
  - original delegated requirement,
  - final result and artifacts,
  - verification evidence or confidence,
  - important findings,
  - blockers, risks, or next steps.
- Keep raw protocol/tool-call diagnostics in fallback metadata for UI/debug inspection.
- Exclude protocol and tool-call details from the parent-visible summary.

## Verification

1. Added regression coverage for a child with failed `ActionResult` followed by wrapper `ConflictError`.
2. The parent-visible summary now contains task-result content.
3. The parent-visible summary does not contain `ActionResult` or `ConflictError`.
4. Fallback metadata still preserves the raw `ActionResult` parser failure and wrapper error for diagnostics.
