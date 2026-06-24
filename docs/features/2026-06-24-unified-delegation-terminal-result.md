# Unified Delegation Terminal Result Handling

## User Goal

Delegated child completion should not depend on whether the assignment expected `ActionResult` or `AgentProtocolOutput`. Runtime should accept either structured carrier and decide what to do from the terminal protocol semantics.

## Agreed Scope

- Accept completed `ActionResult` and completed `AgentProtocolOutput` tool calls as delegated child terminal results.
- Map the result status from the submitted terminal meaning, not from the assignment's configured `result_tool`.
- Keep plain text responses non-terminal for structured `ActionResult` assignments so missing native handoffs still trigger the existing reminder path.
- Treat `AgentProtocolOutput` terminal kinds consistently:
  - `success`, `answer`, and `done` are completed and satisfying.
  - `reply` is delivered but blocked/non-satisfying.
  - `failure` and `error` are failed/non-satisfying.
- Preserve stored `action_result` and `protocol_result` evidence for parent handoff, dependency routing, and debugging.

## Out of Scope

- Changing the model-facing preferred native carrier for planner versus worker agents.
- Accepting arbitrary plain text as a structured child result.
- Changing fallback summary generation for malformed or missing `ActionResult` attempts.
- Changing UI rendering for delegation result cards.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
  - terminal result extraction
  - result status mapping
  - event-driven child completion gate
  - dependency satisfaction checks
- `packages/opencode/test/session/delegation.test.ts`
  - regression coverage for cross-carrier terminal result handling
- `docs/harness-module/protocol-runtime.md`
  - protocol runtime contract documentation

## Implementation Plan

1. Extend delegated protocol terminal parsing to include `answer` and `done`.
2. Add carrier-independent terminal extraction for completed `ActionResult` and `AgentProtocolOutput` tool calls.
3. Update delegated completion to choose the latest structured terminal result by semantic meaning instead of checking `item.result_tool` first.
4. Update assistant-message event handling so either structured carrier can trigger completion for an active delegated assignment.
5. Update dependency satisfaction so protocol `success`, `answer`, and `done` can satisfy downstream actions.
6. Add focused regression tests for `ActionResult` assignments completed by `AgentProtocolOutput` terminal calls.

## Verification Plan

- Run the focused delegation test file from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
