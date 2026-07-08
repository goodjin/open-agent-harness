# Interrupted Delegated Child Settlement

## Goal

Prevent delegated child sessions from staying in `interrupted_active` while their parent keeps waiting with no wake-up path.

## Problem

On bootstrap, restart-lost `running` or `starting` rows are restored as `interrupted`. Bootstrap can auto-continue non-stale interrupted sessions, but sessions with stale pending tool calls are excluded from auto-continue. If such a stale session is also a delegated child, its parent can keep a `pending_delegations` entry forever because no result is stored and no event wakes the parent.

## Scope

- Keep automatic continuation for interrupted sessions that are not stale.
- For stale interrupted delegated children, synthesize a delegation result and notify the parent.
- Leave non-delegated interrupted sessions as inspectable interrupted sessions.
- Do not change the normal `session_result` canonical completion path.

## Implementation Plan

1. Add a `SessionDelegation.settleInterrupted()` helper that only acts on delegated children.
2. Reuse the existing forced submit/fallback path so parent handoff, result storage, and pending cleanup remain centralized.
3. Call that helper during bootstrap for restored interrupted sessions that `SessionRecovery.mark()` identified as stale.
4. Add a regression test for a delegated child restored as `interrupted(prior=running)` with a stale tool, verifying parent pending is cleared and a synthetic result is stored.

## Verification

- Run focused delegation/status tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
