# UI Settings Module

## Custom Provider Editing

Settings treats custom providers created through the provider dialog as config-backed OpenAI-compatible providers. A provider is considered editable when its global config entry uses `@ai-sdk/openai-compatible` and declares at least one model.

Editable custom providers expose an Edit action in the connected provider list. The edit dialog reuses the custom provider form and hydrates from `config.provider[id]`:

- provider id is shown read-only,
- display name, base URL, provider concurrency, provider RPM, model rows, and headers are editable,
- `{env: NAME}` API key references are shown when stored in config,
- a blank API key field preserves the existing stored credential,
- entering a new API key updates provider auth.

Keeping the provider id fixed avoids changing model ids and existing session references.

## Provider/Model Config Hot Update

Saving provider or model parameters from Settings updates global config and refreshes config/provider caches without disposing active project instances. Existing LLM streams keep the model object they started with, while later provider lists, model selection, child session creation, and model calls read the refreshed provider/model definition.

This avoids turning `running` or `starting` sessions into interrupted sessions when a user edits fields such as base URL, headers, provider concurrency, provider RPM, model limits, model concurrency, model RPM, or model options.

## Session Model Selection Scope

Session-local model selection is a hot draft for the active conversation. The UI merges legacy last-message metadata, handoff defaults, persisted session binding, and the user's saved selection by field. The saved local selection wins last so changing the model in the UI is visible immediately and is sent with the next prompt, even when the server still has an older `session.model`.

When that submitted model differs from the server-bound session model, the server owns the final guard and returns a conflict instead of silently rebinding the session. The prompt UI then asks whether to switch the session to the selected model. Confirming retries the same request with `confirm: true`; declining restores the local selector to the bound model and retries with that model.

Direct prompt footer model selection asks before replacing a known session-bound model. Confirming calls the session tree update API with `confirm: true`, so the bound model is updated before later prompts are sent. Cancelling restores the selector to the bound model and does not call the update API. If the local session snapshot is stale and the server still reports a model conflict, the selector keeps the same confirmation fallback instead of showing the raw conflict message.

Session tree bulk edits use the same bound-model guard. Selecting a new model for one or more checked sessions opens a replacement confirmation before the PATCH request is sent. Confirming sends the existing session tree update request with `confirm: true`, which lets the backend replace bound models for the selected sessions.

Agent and model replacement confirmations use the app's internal dialog system, not browser-native `confirm()` prompts. The same internal confirmation is used by prompt footer changes, prompt submission conflict handling, and shell/context continuation conflict handling.

## Settings Workspace Layout

Opening Settings replaces the main workspace content instead of adding another right-side panel. The sidebar remains available, while the session area and any session-side content are replaced by `SettingsPanel` until the user closes Settings.

This keeps settings pages wide enough for provider, model, and agent management screens and avoids nested session/settings panes competing for horizontal space.

## Agent Runtime Limits

Settings > Agents exposes `Max tool calls` in the runtime section. The field writes `maxToolCalls` into agent metadata, and the effective value is also available through agent config overrides. Runtime uses this as the maximum consecutive tool-call count for that agent before blocking the current turn; blank values fall back to the server default of `1000`.
