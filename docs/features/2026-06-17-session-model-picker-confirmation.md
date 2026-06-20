# Session Model Picker Confirmation

## Goal

Changing the model from the prompt footer on an existing session should not surface the backend `confirm=true` conflict as a raw request failure. The user should get a confirm or cancel choice before the session-bound model is overwritten.

## Scope

- Keep the backend session model guard unchanged.
- Handle `409 Conflict` from direct prompt-footer model changes.
- If the user confirms, retry the same session tree update with `confirm: true`.
- If the user cancels, restore the local selector to the current bound session model.
- Avoid changing prompt submission behavior, which already handles model conflicts.

## Affected Modules

- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input/model-conflict.ts`
- `packages/app/src/components/prompt-input/model-conflict.test.ts`
- `docs/harness-module/ui-settings.md`

## Plan

1. Add a small helper that formats the model switch confirmation and returns the confirmed retry payload.
2. Update the prompt footer model selector to catch `409`, ask for confirmation, and retry with `confirm: true` only when approved.
3. Restore the bound model locally when the user cancels.
4. Add focused tests for confirm, cancel, matching model, and missing bound model behavior.
5. Update module documentation for direct model picker behavior.

## Verification

- Run the focused component helper test from `packages/app`.
- Run app typecheck from `packages/app`.
- Run the lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
