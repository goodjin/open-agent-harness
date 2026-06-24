# Delegation Completed Result Reuse

## User Goal

When the user clicks "terminate and summarize" for a parent run, child sessions that are already naturally completed should keep their completed state. Runtime should first reuse any existing child result. Only completed children without a reusable result should get a transcript-based summary.

The user-completed state should also look distinct from an error state in session UI status markers.

## Agreed Scope

- Keep `completed` child session status unchanged during manual terminate-and-summarize.
- Prefer canonical stored delegation results for completed children.
- If no canonical result exists, parse the completed child transcript for native `ActionResult` or terminal `AgentProtocolOutput`.
- Generate a fallback summary only when a completed child has no reusable structured result.
- Continue to mark still-running or otherwise unfinished children as `user_completed` when they are manually terminated for summary.
- Improve user-completed visual treatment in the session timeline/tree status markers.

## Implementation Plan

- Add a delegation result lookup helper that checks stored handoff output, parent completed rows, child `dsl_context.result`, and parsable native result parts.
- In the `terminate_with_result` close path, branch completed children through the lookup before cancellation/status mutation.
- Preserve existing behavior for incomplete children.
- Update targeted delegation tests for completed-with-result and completed-without-result cases.
- Update UI status markers so `user_completed` renders as a lighter success icon instead of a dark/error-like dot.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session-tree-manager.tsx`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run the targeted delegation tests from `packages/opencode`.
- Run package typecheck from `packages/opencode`.
- Run lightweight app tests/typecheck where feasible for the touched UI code.
