# Custom Provider Edit and Settings Workspace

## User Goal

Users should be able to revise a custom OpenAI-compatible provider after adding it. Opening Settings should also use the main workspace area instead of adding a narrow extra panel beside the session.

## Agreed Scope

- Add edit access for custom providers created through the Settings provider flow.
- Reuse the custom provider form for both create and edit paths.
- Keep the provider id fixed while editing, so model references and stored credentials stay stable.
- Preserve existing stored API credentials when the edit form leaves the API key blank.
- Replace the session and right-side content with Settings while Settings is open.
- Do not change non-custom provider auth flows.

## Implementation Plan

- Extend the custom provider form validation with an edit-provider allowance.
- Seed the custom provider dialog from `config.provider[id]` in edit mode.
- Add an Edit action for config-backed custom providers in the connected provider list.
- Change the main layout branch so Settings occupies the full main workspace instead of rendering as an additional right-side aside.
- Add focused tests for editing an existing custom provider config.

## Affected Modules

- `packages/app/src/components/dialog-custom-provider.tsx`
- `packages/app/src/components/dialog-custom-provider-form.ts`
- `packages/app/src/components/dialog-custom-provider.test.ts`
- `packages/app/src/components/dialog-settings.tsx`
- `packages/app/src/components/settings-providers.tsx`
- `packages/app/src/pages/layout.tsx`
- `packages/app/e2e/actions.ts`
- `packages/app/e2e/settings/settings-providers.spec.ts`
- `docs/harness-module/ui-settings.md`

## Verification Plan

- Run the custom provider form test from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run `bun test:e2e:local -- settings/settings-providers.spec.ts` from `packages/app`.
- Run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
