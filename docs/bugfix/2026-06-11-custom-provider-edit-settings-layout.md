# Bug Fix: Custom Provider Edit and Settings Layout

## Problem

- Date: 2026-06-11
- Severity: Medium
- Scope: App Settings provider management and Settings workspace layout.

After adding a custom OpenAI-compatible provider, Settings only offered Disconnect. Users could not reopen the custom provider form to revise the base URL, model list, headers, or concurrency. Settings also rendered as an extra right-side panel beside the session content, leaving less room for Settings.

## Root Cause

- `SettingsProviders` detected config-backed custom providers but only used that check for display and disconnect handling.
- `DialogCustomProvider` only supported an empty create state. It did not accept a provider id, hydrate from `config.provider[id]`, or allow the current provider id to pass duplicate validation.
- `Layout` rendered Settings as a second child beside `props.children`, with the session pane hidden only on larger breakpoints.

## Fix

- Added an edit mode to `DialogCustomProvider`.
- Hydrated existing name, base URL, env key reference, concurrency, model rows, and header rows from the provider config.
- Locked provider id during edits so existing model references and credentials remain stable.
- Preserved existing provider options while allowing edited headers to be removed.
- Added an Edit button for config-backed custom providers.
- Changed the layout to render either Settings or the normal session content in the main workspace.

## Verification

1. `bun test src/components/dialog-custom-provider.test.ts` from `packages/app`.
2. `bun typecheck` from `packages/app`.
3. `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
4. `bun test:e2e:local -- settings/settings-providers.spec.ts` from `packages/app`.
5. Browser verification at `http://localhost:4444/` confirmed:
   - Settings uses the main workspace with no `main aside`.
   - Custom provider rows show Edit.
   - Edit dialog hydrates existing provider id and base URL.
   - Provider id is read-only and submit text is Save.
