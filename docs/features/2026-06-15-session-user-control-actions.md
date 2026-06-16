# Session User Control Actions

## User Goal

Users need direct controls for sessions that are waiting, interrupted, failed, blocked, or otherwise not naturally completed. A user should be able to mark a session as completed by user decision, stop waiting for delegated child sessions, or cancel child work while preserving enough audit trail for later inspection.

## Agreed Scope

- Add a distinct `user_completed` session status for manual completion. This must not be conflated with runtime `completed`.
- Allow manual completion from unfinished, interrupted, waiting, failed, blocked, paused, timeout, and aborted states.
- Let a parent session in `waiting_child` stop waiting by submitting current child statuses through the existing delegation aggregate handoff path.
- Let a parent cancel pending child sessions and notify each child with a user-cancel command before marking the child cancelled.
- Surface the new controls in the session timeline delegation UI and session status labels.
- Keep all status changes routed through `SessionStatus.set()` so existing `session.status.changed` logs remain the audit source.

## Out of Scope

- Full pause/resume semantics for running provider requests beyond the existing cancellation path.
- A general arbitrary state editor that can set any status without guardrails.
- Changing the canonical `ActionResult` protocol for normal child completion.

## Implementation Plan

- Extend `SessionStatus.Info` and transition rules with `user_completed`.
- Add guarded session control routes for marking a session user-completed and cancelling delegated children.
- Reuse `SessionDelegation.submit({ force: true })` for stop-waiting behavior.
- Add delegation cancellation support that writes a command prompt to child sessions, cancels active prompts, updates child status, then force-submits the run to the parent.
- Update timeline actions and labels so users can distinguish natural completion from user-marked completion.
- Add focused tests for status transitions and delegation force/cancel behavior.

## Affected Modules

- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/session-delegations.ts`
- `packages/app/src/pages/session/session-insight-banner-helpers.ts`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-console.md`

## Verification Plan

- From `packages/opencode`, run focused tests for session status and delegation behavior.
- From `packages/opencode`, run `bun typecheck`.
- From `packages/app`, run focused UI tests if touched helpers have coverage.
- From `packages/app`, run `bun test:e2e:local -- app/smoke.spec.ts` after frontend changes.
