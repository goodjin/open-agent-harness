# Session Result Canonical Delegation Completion

## Goal

Fix parent sessions that remain in `waiting_child` after delegated children have already produced results.

## Agreed Scope

- Treat `session_result` as the canonical source for delegated child completion.
- Use `session_result.satisfying` to decide whether dependency gates are satisfied.
- Keep `pending_delegations` as a live assignment projection, not the completion source of truth.
- Keep `completed_delegations` as a compatibility projection for existing UI and history, not the authoritative completion marker.

## Affected Modules

- `packages/opencode/src/session/result.ts`
  - Add parent/run result listing helpers.
- `packages/opencode/src/session/delegation.ts`
  - Use `session_result` for delegation query, finalize summaries, delivery checks, dependency gates, and progress.
- `packages/opencode/src/session/prompt.ts`
  - Remove pending assignments when a matching result exists.
- `packages/opencode/src/session/status.ts`
  - Repair `waiting_child` against canonical result rows before checking child lifecycle status.
- `packages/opencode/src/session/runtime-tools.ts`
  - Surface result rows even when child `dsl_context.result` is missing.

## Implementation Plan

1. Add `SessionResult.listForParentRun` and parse metadata needed by delegation summaries.
2. Change delegation status/finalization/progress/delivery checks to resolve completion from `session_result`.
3. Change dependency readiness to use satisfying result rows.
4. Change waiting repair paths to prune pending children that already have canonical result rows.
5. Add focused regression tests for stale `waiting_child` with pending assignments plus existing `session_result`.

## Verification

- Run focused session tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
