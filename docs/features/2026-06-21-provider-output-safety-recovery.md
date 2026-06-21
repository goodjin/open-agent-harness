# Provider Output Safety Recovery

## User Goal

When a provider stream fails with messages like `output new_sensitive (1027)`, classify it as a provider output safety block instead of a generic unknown error, and expose a clear way for the user to continue the session.

## Agreed Scope

- Detect MiniMax-style output safety stream errors.
- Preserve the original provider message for logs and diagnostics.
- Store a readable session status with a recoverable marker.
- Allow recoverable provider safety errors to receive a new user prompt.
- Add a timeline option that continues the session with a short retry instruction.

## Out of Scope

- Automatically replaying the exact failed provider request.
- Changing provider safety policy behavior.
- Changing generic completed or failed session affordances.

## Implementation Plan

1. Extend provider stream error parsing for `output new_sensitive (1027)`.
2. Map the parsed error to `MessageV2.APIError` metadata.
3. Extend `SessionStatus.error` with optional `reason` and `recoverable` fields.
4. Set recoverable session status for provider output safety blocks.
5. Permit prompts into recoverable error sessions.
6. Render a timeline error recovery card with a continue action.

## Affected Modules

- `packages/opencode/src/provider/error.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/status.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session.tsx`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Add focused tests for provider safety parsing and session status shape.
- Run targeted Bun tests from `packages/opencode`.
- For frontend behavior, run the app smoke test from `packages/app` if frontend compile impact is non-trivial.
