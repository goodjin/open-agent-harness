# Session Header Stats and Status Logs

## User Goal

Restore the session title bar statistics for token usage and model identity, show the current session status name, keep the timeline filter bar opaque, and add log records for every session status transition.

## Agreed Scope

- Show model, current status, token usage, and cost in the active session title bar.
- Keep the existing session timeline controls, title editing, context usage, and menu behavior.
- Make the turn filter bar opaque so it does not visually cover timeline content with transparent background.
- Record a session log entry whenever the session status changes.
- Each status log records the previous status, new status, and the reason inferred from the status payload or transition context.
- Add a status filter to the logs panel.

## Implementation Plan

- Reuse the existing session insight helper functions for model and token summaries.
- Add compact stats chips to `MessageTimeline`, where the current title bar is rendered.
- Replace the sticky title row gradient background with a solid background and border.
- Emit `session.status.changed` from `SessionStatus.set()` after transition validation.
- Teach the log timeline to describe, group, filter, and count status transition records.
- Add focused tests for the status log display and status transition emission.

## Affected Modules

- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/session-log-timeline.tsx`
- `packages/app/src/pages/session/session-log-timeline.test.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/test/session/status.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run focused session log timeline tests from `packages/app`.
- Run focused session status tests from `packages/opencode`.
- Run `bun typecheck` from affected package directories if focused tests expose type issues.
- Run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app` after frontend changes.
