# Session Live Status Bar

## User Goal

The session view should continuously show what the active session is doing. A running session must not leave the bottom composer area blank when a request is queued, sent, generating, thinking, calling tools, replying with text, waiting on concurrency, waiting on user input, or waiting on child sessions.

## Agreed Scope

- Add a compact live status line above the prompt input in the session composer area.
- Derive the status from existing synchronized session status, messages, and message parts.
- Prefer precise runtime states when available, including permission/user waits, child-session waits, rate limits, retries, reasoning parts, running tool parts, text parts, and newly sent user requests.
- Keep the display concise: one status label plus a short description.
- Avoid backend schema changes unless the existing event stream cannot support the display.

## Implementation Plan

- Add a pure helper that derives a bottom status model from `SessionStatus`, session messages, and parts.
- Cover the helper with focused tests before implementation.
- Expose the derived status from `createSessionComposerState`.
- Render the status in `SessionComposerRegion` above `PromptInput`, alongside existing todo, revert, follow-up, question, and permission docks.
- Keep the component layout bounded so the prompt dock does not jump or overlap.

## Affected Modules

- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `packages/app/src/pages/session/composer/session-composer-state.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run the targeted app session helper tests from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the required lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
