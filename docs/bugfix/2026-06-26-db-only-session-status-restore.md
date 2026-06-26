# 2026-06-26 DB-Only Session Status Restore

## Goal

Make the session row the only source used for current lifecycle status.

## Scope

- Stop writing `session_status/<session_id>.json` snapshots from `SessionStatus.save()`.
- Stop reading `session_status` snapshots from `SessionStatus.restore()`.
- Keep a regression test proving a stale status file cannot revive a DB-idle session.
- Update module documentation to describe DB-only restore semantics.

## Verification

- Run focused session status tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
