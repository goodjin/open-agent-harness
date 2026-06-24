# Protocol Input Question Rehydrate

## User Goal

Protocol `input` items should keep their user-choice prompt visible and actionable even when the page reloads, the app reconnects, or the active turn changes. A model-emitted `input` item with options should reliably show the option box until the user answers or dismisses it.

## Agreed Scope

- Persist pending protocol `input` questions in session `dsl_context`.
- Restore pending protocol `input` questions from `/question`, similar to existing protocol confirmation recovery.
- Bridge replies to restored `input` questions back into the parent session with the captured answer text.
- Surface the active pending question in the composer dock so it is not hidden only because the timeline active message changed.
- Add focused regression coverage for backend restore and frontend request matching.

## Out of Scope

- Changing `confirm` semantics.
- Changing the Agent Protocol v2 item schema.
- Replaying historical sessions that already lost their in-memory question request.
- Changing child-session delegation semantics.

## Implementation Plan

1. Store a protocol input record before calling `Question.ask`.
2. Mark that record answered or rejected after a live reply.
3. Extend `/question` to restore pending input records in addition to pending confirmations.
4. Extend `/question/:requestID/reply` and `/reject` to handle restored input records by sending a continuation prompt with the selected answers.
5. Render pending questions in the composer dock as a stable fallback while keeping the existing timeline card.
6. Cover the behavior with focused tests and update protocol runtime documentation.

## Affected Modules

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/server/routes/question.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/session-confirmation-match.ts`
- `packages/opencode/test/session/runner.test.ts`
- `packages/app/src/pages/session/message-timeline.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run focused protocol runner tests from `packages/opencode`.
- Run focused session timeline tests from `packages/app`.
- Run package typecheck from touched package directories if focused tests pass.
