# Bug Fix: Session model update confirmation

## Problem

- Date: 2026-06-24
- Severity: Medium
- Impact: Existing sessions and session tree bulk edits

Changing the model on an already bound session could surface the backend `confirm=true` conflict as a request failure. Session tree bulk model updates also sent model changes without confirmation, so selected bound sessions failed instead of asking the user to confirm replacement.

## Root Cause

- `packages/app/src/components/prompt-input.tsx` only handled model replacement after a failed update path.
- `packages/app/src/pages/session-tree-manager.tsx` only attached `confirm` for agent changes, not model changes.
- Session tree conflict parsing only recognized bound-agent conflicts.

## Fix

- Added proactive model update confirmation for prompt footer model changes.
- Added session tree helper coverage for update body construction and model conflict parsing.
- Added session tree bulk model replacement confirmation and confirmed `confirm: true` requests.
- Added session tree model confirmation copy.

## Verification

1. Focused tests: `bun test ./src/components/prompt-input/model-conflict.test.ts ./src/pages/session-tree-manager-helpers.test.ts`
2. Typecheck: `bun typecheck`
3. App smoke: `bun test:e2e:local -- app/smoke.spec.ts`
