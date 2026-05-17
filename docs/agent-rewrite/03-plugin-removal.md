# MOD-05 Plugin Removal

## Decision

The fork intentionally removes the upstream plugin runtime. JavaScript/TypeScript files in `.opencode/plugin` or `.opencode/plugins` are no longer loaded, the top-level `plugin` config key is rejected by schema validation, and provider/tool/session/shell hook events are not emitted.

## Call Site Inventory

| Area | Removed hook | Resolution |
|---|---|---|
| Project bootstrap | `Plugin.init()` | Removed; there is no plugin lifecycle. |
| Shell and PTY | `shell.env` | Removed; PTY creation still accepts explicit request env, and bash/command execution inherit `process.env`. |
| Provider loading | `Plugin.list()` auth loaders | Removed; supported provider auth is models.dev, env vars, saved auth, and first-class custom loaders. |
| Provider CLI | plugin auth picker/providers | Removed; `auth login` lists supported providers plus `Other` for storing a custom provider credential. |
| Tool registry | plugin tools and `tool.definition` | Plugin tool loading removed; the supported extension path is `.opencode/tool(s)/*.ts` custom tool definitions. |
| Session/LLM | chat params, headers, message transforms, text completion, command/tool events | Removed; model/provider/agent config and built-in permission events are the supported paths. |
| TUI status/tips | plugin counts and plugin tips | Removed so the UI no longer advertises inactive plugin behavior. |

## Migration

- Move custom LLM tools from plugin `tool` hooks to `.opencode/tools/*.ts`.
- Move provider configuration into the `provider` config block and credentials into `opencode auth login` or environment variables.
- Move shell environment setup into the process environment before launching opencode, or pass explicit `env` when using the PTY API.
- Replace event-style automation with MCP servers, custom commands, or first-class fork features as they are added.

Existing plugin packages are not executed by this fork. Keeping plugin entries in config is treated as an invalid configuration so migration failures are visible instead of silently ignored.
