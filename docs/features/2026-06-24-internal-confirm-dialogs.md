# Internal Confirm Dialogs

## Goal

Session model and agent replacement confirmations should use the app's internal dialog system instead of browser-native `confirm()` dialogs.

## Scope

- Replace prompt footer model replacement confirmation.
- Replace prompt footer agent replacement confirmation.
- Replace prompt submit model and agent replacement confirmations.
- Replace session shell/context model replacement confirmations.
- Keep session tree bulk update dialogs as-is because they already use internal `Dialog`.

## Affected Modules

- `packages/app/src/components/confirm-dialog.tsx`
- `packages/app/src/components/confirm-dialog.test.tsx`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input/model-conflict.ts`
- `packages/app/src/components/prompt-input/model-conflict.test.ts`
- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
- `packages/app/src/pages/session.tsx`
- `docs/harness-module/ui-settings.md`

## Implementation Plan

1. Add a small internal confirm dialog helper that wraps `useDialog()` and resolves a boolean.
2. Make model conflict helpers accept async confirmation callbacks.
3. Inject the internal confirmation callback into prompt submit code.
4. Replace the shell/context model conflict confirmation with the same internal dialog helper.
5. Add focused tests for async confirmation and submit confirmation injection.

## Verification Plan

- Run focused app tests from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
