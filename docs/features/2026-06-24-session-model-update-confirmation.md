# Session Model Update Confirmation

## Goal

Changing a model on an existing session should ask before replacing the server-bound model, then update the session binding through the existing session tree update API when the user confirms.

## Scope

- Prompt footer model changes on an existing session.
- Session tree bulk model updates for selected sessions.
- Keep the backend bound-model guard unchanged.
- Use the existing session tree update endpoint with `confirm: true` for confirmed model replacement.
- Keep cancellation local: no update request should be sent after the user declines a proactive model replacement prompt.

## Affected Modules

- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input/model-conflict.ts`
- `packages/app/src/components/prompt-input/model-conflict.test.ts`
- `packages/app/src/pages/session-tree-manager.tsx`
- `packages/app/src/pages/session-tree-manager-helpers.ts`
- `packages/app/src/pages/session-tree-manager-helpers.test.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`
- `docs/harness-module/ui-settings.md`

## Implementation Plan

1. Extend the model conflict helper so callers can ask proactively when the currently bound model differs from the requested model.
2. Update prompt footer model selection to ask before calling `session.tree2.update` when the active session already has a different bound model.
3. Add session tree helper coverage for update body confirmation rules and conflict parsing.
4. Update session tree bulk changes so model replacement receives the same confirmation handling as agent replacement.
5. Add model replacement dialog copy for the session tree.

## Verification Plan

- Run focused app tests for model conflict and session tree helper behavior from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
