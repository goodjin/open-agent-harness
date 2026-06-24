# Delegation Force Stop Actions

## User Goal

When a parent session stops waiting for delegated children, pending child sessions should not continue independently. The UI should expose two explicit outcomes:

- cancel child sessions and continue without results
- terminate child sessions, collect the best available result, and continue

## Agreed Scope

- Replace the existing non-destructive "do not wait" path with a terminating result-collection path.
- Keep a separate cancellation path that discards child results.
- Preserve backward compatibility for existing `force: true` submit calls where practical.
- Ensure both user-facing actions clear pending delegations for the selected run.

## Implementation Plan

- Extend delegation submit input with a mode:
  - `cancel_without_result`
  - `terminate_with_result`
- Map legacy `force: true` submit calls to `terminate_with_result`.
- For `cancel_without_result`, abort pending children, store a canceled result, and continue the parent without transcript summary.
- For `terminate_with_result`, stop pending children, use existing structured results when present, otherwise generate a transcript-based handoff summary, then continue the parent.
- Update the session timeline footer buttons and labels.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/opencode/test/session/delegation.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Add backend regression coverage for both submit modes.
- Run targeted session delegation tests from `packages/opencode`.
- Run package typecheck where feasible from package directories.
