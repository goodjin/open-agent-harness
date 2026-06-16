# ActionResult Tool Loop Guard

## User Goal

When a delegated session repeatedly calls `ActionResult` with malformed or empty arguments, runtime should preserve the original model/tool-call input in logs, classify the handoff attempt, and stop the loop instead of consuming provider/model slots indefinitely.

## Agreed Scope

- Record raw `ActionResult` tool-call input in session logs before schema repair turns it into a generic parser error.
- Treat every `ActionResult` call as a handoff attempt with an explicit outcome.
- Stop a session after more than three consecutive failed `ActionResult` attempts.
- Add an agent-level maximum tool-call loop limit with default `1000`.
- Expose the maximum tool-call limit in Settings > Agents.
- Return the strict `ActionResult` protocol again when schema parsing fails, including direct-argument rules, runtime-derived worker/verifier branch semantics, required fields, status values, and a valid example.
- Ignore stale `ActionResult` input fields such as `role`, `result_type`, `kind`, and `summary` instead of treating them as protocol instructions.

## Implementation Plan

- Extend agent config/template metadata with `maxToolCalls`, plus config overlay support for package and built-in agents.
- Track tool-call count and consecutive `ActionResult` failures inside the prompt loop for the active agent.
- Log `tool.action_result` outcome records and include bounded raw tool input on `tool.error`.
- Store full LLM response event payloads, expose bounded previews on failed tool parts/logs, and link those previews to exportable response payloads.
- Centralize the `ActionResult` protocol text so delegated prompts and schema-failure repair messages use the same result-shape and field rules.
- Mark sessions `blocked` when either guard is exceeded.
- Update Agent Settings helpers and runtime form controls to read/write `maxToolCalls`.

## Affected Modules

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/agent/schema.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/agent/manage.ts`
- `packages/app/src/components/settings-agents.tsx`
- `packages/app/src/components/settings-agents-helpers.ts`
- `packages/app/src/pages/session/session-log-timeline.tsx`
- `packages/ui/src/components/tool-error-card.tsx`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-settings.md`

## Verification Plan

- Add or update focused tests for ActionResult failure guard and agent max tool-call limit.
- Run package typecheck from `packages/opencode`.
- Run app typecheck from `packages/app` after Settings changes.
