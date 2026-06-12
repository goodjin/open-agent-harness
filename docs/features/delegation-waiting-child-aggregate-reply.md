# Delegation Waiting Child Aggregate Reply

## Goal

Fix parent sessions that become `completed` while delegated child sessions are still running, then fail to react when later child results arrive.

## Scope

- Add a `waiting_child` session status for parents that are waiting on delegated child sessions.
- Record every child result when it arrives.
- Resume the parent only after all child sessions for the parent delegation set have reached an end state.
- Treat non-resumable child end states such as `interrupted`, `aborted`, `failed`, `timeout`, `error`, and `blocked` as ended, and include their status in the parent summary.
- Send the parent a natural Markdown summary instead of a JSON delegation result payload.
- Keep `blocked` as a terminal child outcome, not as the parent waiting state.

## Implementation Plan

1. Extend `SessionStatus` with `waiting_child` and add valid transitions around normal running, waiting, and completed states.
2. Update prompt loop completion so a session with pending delegated children remains `waiting_child` instead of `completed`.
3. Update prompt loop stale-turn detection to require the finished assistant to answer the latest user turn by `parentID`.
4. Update delegation completion so child results are stored immediately, but parent prompting waits until all pending child sessions are terminal.
5. Build a Markdown aggregate result message for the parent with child session ids, actions, statuses, and summaries.
6. Update UI busy/working status helpers so `waiting_child` is displayed as an active waiting state.
7. Add targeted tests for status transitions, turn completion, and multi-child delegation aggregation.

## Affected Modules

- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/app/src/pages/session/*`
- `packages/app/src/pages/layout/*`
- `docs/harness-module/*`

## Verification Plan

- Run focused session status and delegation tests from `packages/opencode`.
- Run focused app helper tests from `packages/app`.
- Run `bun typecheck` from affected package directories.
- Run app smoke check if frontend changes require it.
