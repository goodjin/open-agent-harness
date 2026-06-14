# Global RPM Limiter

## User Goal

Add a global requests-per-minute limiter for model calls so a small number of active agent sessions cannot exceed upstream provider RPM limits. The limiter must be configurable from Settings and from the built-in server config APIs.

## Agreed Scope

- Support provider-level `rpm` and model-level `rpm` limits.
- Keep existing provider/model `concurrency` behavior unchanged.
- Enforce limits globally inside the running server process before each LLM request starts.
- Expose `rpm` through config schema, provider schema, config routes, generated SDK types, and the custom provider settings UI.
- Show queued sessions with `rate_limited` status while waiting for either concurrency or RPM capacity.

## Implementation Plan

1. Extend provider and config schemas with optional positive integer `rpm` fields.
2. Update `LLMConcurrency` so acquire checks both active concurrency and rolling one-minute start counts.
3. Add a timer to wake queued requests when the RPM window opens, because no active request may release at that moment.
4. Add provider and model RPM fields to the custom provider form, validation, payload generation, and translations.
5. Regenerate SDK output after schema changes.
6. Add focused runtime and form tests.

## Affected Modules

- `packages/opencode/src/session/llm-concurrency.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/app/src/components/dialog-custom-provider*.ts*`
- `packages/app/src/i18n/*.ts`
- `packages/sdk/js`

## Verification Plan

- Run LLM concurrency unit tests from `packages/opencode`.
- Run custom provider form tests from `packages/app`.
- Run `bun typecheck` from affected package directories.
- Run app smoke test from `packages/app` because Settings UI changes.
