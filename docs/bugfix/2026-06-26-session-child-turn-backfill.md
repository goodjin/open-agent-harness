# Session Child Turn Backfill

## Problem

`Protocol: replan_m9_epic_03_member_lifecycle_flows (@epic-planner)` has delegated child sessions, but opening the session did not show the child session list.

## Diagnosis

The session has five direct child sessions and persisted `metadata.turn.children` on the first user turn. The initial frontend message page loads only the latest five messages; this session has six messages, so the child-owning first user turn was outside the initial window.

The child metadata also had completed children with `current: true`, even though each row had a completed status/result notification. The UI should treat completed/notified rows as historical even when stale `current` remains true.

## Fix

- Backfill older messages after the main session is ready when the full session has delegation context but the currently loaded timeline has no delegation-bearing user turn.
- Interpret completed/notified timeline child rows as completed history even if `current` is stale.

## Verification

- Add focused `session-delegations` unit coverage.
- Run app session delegation tests.
- Run app smoke because frontend code changed.
