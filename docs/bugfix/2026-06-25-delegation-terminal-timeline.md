# Bug Fix: Delegation Terminal Cleanup and Timeline Controls

## Problem

- Date: 2026-06-25
- Severity: High
- Scope: delegated child completion, parent `waiting_child` state, session timeline controls, reasoning part titles

`plan_m9_todo_fill` stayed in `waiting_child` after its visible child sessions had ended. The parent timeline child-session list could also disappear after later input because it was tied only to the original turn filter. A related UI issue changed reasoning frame titles when the reasoning content was collapsed.

## Root Cause

- Runtime: a child session can reach a terminal `SessionStatus` without a native terminal `ActionResult` or `AgentProtocolOutput` result, for example after malformed protocol output. Existing `SessionDelegation.close()` can synthesize a result for ended children, but it only runs when a parent finalize or manual submit path is invoked. A terminal child status by itself does not currently trigger parent run finalization.
- Timeline: delegation rows are derived from `dsl_context.protocol.pending_delegations` and `completed_delegations` per turn. Later user input can move the visible active turn away from the original delegation turn, making the child list feel unstable.
- Reasoning title: collapsed reasoning output uses a heading extracted from the reasoning text, so the title changes from the stable frame label to a content-derived label.

## Fix Plan

1. Subscribe `SessionDelegation` to terminal session status events. When a delegated child reaches a terminal status, finalize the parent run after the status state is written, synthesize a result for ended children when needed, and notify the parent once per run through the existing claim path.
2. Keep delegation rows stable in the timeline after the user opens or submits the control. If there is later user input, confirm before `terminate_with_result` because it immediately collects current child results and submits them to the parent.
3. Lock the child list after a submit action: rows remain inspectable, but no further row/run operations are exposed and the submit button becomes a clicked state.
4. Keep collapsed reasoning titles equal to the normal reasoning frame title.

## Verification Plan

1. Run focused backend delegation tests from `packages/opencode`.
2. Run focused UI helper/session-turn tests from `packages/app` and `packages/ui`.
3. Run package typechecks from touched package directories.
4. Run app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.

## Documentation Impact

- Update `docs/harness-module/protocol-runtime.md` for terminal child status cleanup.
- Update `docs/harness-module/ui-console.md` for stable timeline delegation controls and reasoning titles.
