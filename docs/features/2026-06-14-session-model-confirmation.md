# Session Model Change Confirmation

## Goal

Prevent prompt requests from silently rebinding an existing session to a different model. The frontend already sends the selected model with each prompt, so the backend must treat a mismatch against the session-bound model as a confirmation gate.

## Scope

- Backend prompt and tree session update requests compare the requested model with the current session model.
- A different bound model is rejected unless the request includes `confirm: true`.
- The frontend catches the backend conflict during normal prompt submission.
- If the user confirms, the prompt is retried with `confirm: true`.
- If the user declines, the UI switches back to the session-bound model and retries with that model.

## Affected Modules

- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/server/session-tree.test.ts`

## Plan

1. Extend `Session.setModel` with an optional `confirm` flag and raise a conflict when an existing model would be overwritten without confirmation.
2. Thread `confirm` through `SessionPrompt.PromptInput`, prompt routes, and session tree batch updates.
3. Add frontend submit retry handling for model conflicts while preserving the user's current prompt payload.
4. Add focused tests for backend conflict behavior and frontend confirm/cancel retry paths.
5. Update the relevant harness module documentation after implementation.

## Verification

- Run focused `packages/opencode` tests for prompt model binding and tree session updates.
- Run focused `packages/app` submit tests for model mismatch confirmation.
- Run `bun typecheck` from changed package directories.
- Run the app smoke check from `packages/app` because frontend behavior changed.
