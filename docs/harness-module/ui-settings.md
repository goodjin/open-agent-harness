# UI Settings Module

## Custom Provider Editing

Settings treats custom providers created through the provider dialog as config-backed OpenAI-compatible providers. A provider is considered editable when its global config entry uses `@ai-sdk/openai-compatible` and declares at least one model.

Editable custom providers expose an Edit action in the connected provider list. The edit dialog reuses the custom provider form and hydrates from `config.provider[id]`:

- provider id is shown read-only,
- display name, base URL, provider concurrency, model rows, and headers are editable,
- `{env: NAME}` API key references are shown when stored in config,
- a blank API key field preserves the existing stored credential,
- entering a new API key updates provider auth.

Keeping the provider id fixed avoids changing model ids and existing session references.

## Settings Workspace Layout

Opening Settings replaces the main workspace content instead of adding another right-side panel. The sidebar remains available, while the session area and any session-side content are replaced by `SettingsPanel` until the user closes Settings.

This keeps settings pages wide enough for provider, model, and agent management screens and avoids nested session/settings panes competing for horizontal space.
