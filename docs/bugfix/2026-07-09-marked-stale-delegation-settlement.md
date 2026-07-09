# Marked Stale Delegation Settlement

## Goal

Settle delegated child sessions that were already marked as stale before the interrupted-delegation bootstrap fix existed.

## Problem

`SessionRecovery.mark()` only returns sessions whose tool parts are still `pending` or `running`. Older rows may already have been marked as `error` with `metadata.recovery.status=stale_interrupted`. Those rows no longer appear in the fresh recovery packet list, so bootstrap does not include them in its stale set. If one of those rows is a delegated child, it can remain `interrupted_active` with no `session_result` and no parent handoff.

## Scope

- Detect previously marked stale tool parts.
- Include those session ids in the bootstrap stale set.
- Keep the existing delegated settlement path as the single parent handoff path.
- Do not change ordinary non-delegated interrupted session behavior.

## Implementation Plan

1. Add a recovery helper that finds sessions in the current project directory with tool parts already marked `stale_interrupted`.
2. Merge those session ids with newly detected stale packets during bootstrap.
3. Add a regression test for an interrupted delegated child whose stale tool was marked before bootstrap.

## Verification

- Run focused delegation/status tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
