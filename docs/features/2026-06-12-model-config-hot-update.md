# Model Config Hot Update

## User Goal

Updating provider or model parameters from Settings should not stop active sessions. The new values should apply to later model selection and later LLM requests while already-started requests keep their original model binding.

## Agreed Scope

- Keep active session runtime state alive when global or project config changes only affect provider/model settings.
- Refresh config and provider/model caches so later reads see the saved values.
- Do not swap the model for an LLM stream that is already in flight.
- Preserve explicit dispose/reload behavior for operations that intentionally dispose instances.

## Implementation Plan

- Add targeted reset support for `Instance.state` entries.
- Let config writes invalidate `Config` state instead of disposing the whole instance.
- Let config routes invalidate provider cache after config writes.
- Keep frontend refresh behavior through the existing `globalSync.updateConfig` bootstrap path.

## Affected Modules

- `packages/opencode/src/project/state.ts`
- `packages/opencode/src/project/instance.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/server/routes/config.ts`
- `packages/opencode/src/server/routes/global.ts`

## Verification Plan

- Add a backend test that sets a session to `running`, updates global model/provider config, and verifies the session status remains `running`.
- Verify provider cache reloads by checking updated model concurrency after global config update.
- Run targeted config tests from `packages/opencode`.
