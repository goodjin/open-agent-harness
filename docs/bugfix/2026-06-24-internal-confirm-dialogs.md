# Bug Fix: Internal confirm dialogs for session binding changes

## Problem

- Date: 2026-06-24
- Severity: Medium
- Impact: Session agent/model replacement confirmations

Session binding replacement prompts used browser-native `confirm()` dialogs in prompt footer, prompt submit, and shell/context continuation flows. Those dialogs do not match the app UI and bypass the internal dialog system.

## Root Cause

- `packages/app/src/components/prompt-input.tsx` used `globalThis.confirm` for prompt footer agent/model replacement.
- `packages/app/src/components/prompt-input/submit.ts` used `globalThis.confirm` for agent/model conflicts before sending.
- `packages/app/src/pages/session.tsx` used `globalThis.confirm` for shell/context model conflicts.

## Fix

- Added `useConfirmDialog()` backed by the app's `Dialog` component.
- Converted model conflict helpers to async confirmation callbacks.
- Injected the internal confirmation callback into prompt submission.
- Replaced shell/context model conflict confirmation with the internal dialog.
- Added focused tests that fail if submit falls back to native `confirm()`.

## Verification

1. Focused tests: `bun test ./src/components/prompt-input/model-conflict.test.ts ./src/components/prompt-input/submit.test.ts ./src/pages/session-tree-manager-helpers.test.ts`
2. Typecheck: `bun typecheck`
3. App smoke: `bun test:e2e:local -- app/smoke.spec.ts`
