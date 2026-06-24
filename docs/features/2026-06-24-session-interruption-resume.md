# Session Interruption Resume Prompt

## User Goal

When a session is interrupted by a process restart or another abnormal stop and is not automatically continued, the session UI should show an explicit prompt that lets the user choose whether to continue.

## Agreed Scope

- Keep the existing bootstrap auto-continue behavior for sessions that are safe to revive.
- Do not show a continue button while a session is already running, queued, rate-limited, retrying, or otherwise being automatically continued.
- Show a root-session prompt for stopped abnormal states that need user action.
- Reuse the existing `/session/tree/resume` restore path rather than adding a new backend status or endpoint.

## Implementation Plan

- Preserve `InstanceBootstrap()` and `revive()` automatic continuation semantics.
- Add a UI helper that maps manual-resume session states to a compact prompt.
- Render the prompt above `PromptInput` in the session composer region.
- Wire the prompt button to `/session/tree/resume` with `mode: "restore"` for the current session.
- Refresh the current session after the restore request.

## Affected Modules

- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `packages/app/src/pages/session.tsx`
- `docs/harness-module/ui-console.md`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Add focused helper tests for automatic states, interrupted sessions, and abnormal stopped states.
- Run `bun test src/pages/session/helpers.test.ts` from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
