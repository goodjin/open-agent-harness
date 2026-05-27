# Agent Model And Authoring

Agent templates live under `config/agents/<id>/` with `meta.json`, plus optional `identity.md` and `rules.md`. The `<id>` directory name must match `meta.json.id`, and ids must be unique after package and user templates are combined.

This document defines the Harness agent authoring contract. An agent is a runtime-governed execution identity with entry rules, capability metadata, prompt material, model preference, and permission policy.

Runtime loads package, user, and project templates into one registry. Later templates with the same id override earlier templates. Invalid templates produce diagnostics but do not prevent valid templates from loading.

Harness separates three concerns:

- `entry`: where the agent can be invoked.
- `capability`: what the agent is suitable for.
- `permission`: what the agent may actually do in a specific assignment.

## Required fields

- `id`: stable template id. Use the same value as the directory name. Whitespace is trimmed and blank values are rejected.
- `name`: display name. Whitespace is trimmed and blank values are rejected.
- `persona`: short behavioral contract for prompt construction. Whitespace is trimmed and blank values are rejected.
- `description`: user-facing summary. Whitespace is trimmed and blank values are rejected.

## Optional fields and defaults

- `model_preference`: `{ "providerID": "...", "modelID": "..." }`. When provider/model catalogs are available, both ids must exist.
- `mode`: import alias for coarse entry presets. Public protocol output should expose resolved `entry`.
- `hidden`: defaults to `false`.
- `workflow_mode`: defaults to `auto`.
- `allowed_tools`: defaults to `[]`.
- `denied_tools`: defaults to `[]`.
- `inherit_permissions`: defaults to `true`.
- `permission_mode`: defaults to `strict`.

## Entry Model

`entry` is the source of truth for where an agent can be used. It is deliberately separate from permissions and scheduling quality.

```json
{
  "entry": {
    "primary": true,
    "delegable": true,
    "mentionable": true,
    "default": true,
    "hidden": false
  }
}
```

Field meanings:

- `primary`: may run as the main conversation agent and appear in the primary agent switcher.
- `delegable`: may be launched by task/delegation machinery.
- `mentionable`: may be invoked directly by user mention or autocomplete.
- `default`: may be selected by default-agent resolution.
- `hidden`: should not appear in normal user-facing pickers even if another entry flag is true.

When a loader receives a coarse `mode` alias, it resolves it into explicit entry flags:

- `primary`: `{ "primary": true, "delegable": true, "mentionable": true, "default": true, "hidden": false }`
- `subagent`: `{ "primary": false, "delegable": true, "mentionable": true, "default": false, "hidden": false }`
- `all`: `{ "primary": true, "delegable": true, "mentionable": true, "default": true, "hidden": false }`

If both `entry` and `mode` are present, `entry` wins. Runtime APIs should return resolved entry flags so UI, routing, and delegation do not need to interpret aliases.

Selection rules:

- primary switcher: `entry.primary && !entry.hidden`
- mention autocomplete: `entry.mentionable && !entry.hidden`
- delegation candidates: `entry.delegable && !entry.hidden`
- default-agent eligibility: `entry.primary && entry.default && !entry.hidden`

## Capability Model

`capability` describes what the agent is good for. Dispatchers and prompt builders should use this metadata together with `description`, not `mode`, to decide when to delegate.

```json
{
  "capability": {
    "purpose": "architecture_review",
    "tags": ["architecture", "debugging", "review"],
    "cost": "high",
    "writes": false
  }
}
```

Field meanings:

- `purpose`: short stable routing hint.
- `tags`: searchable capability tags for prompt generation and dispatch tables.
- `cost`: relative execution cost, one of `low`, `medium`, or `high`.
- `writes`: declarative metadata for whether the agent is intended to modify workspace state.

`capability.writes` is intentionally metadata, not permission enforcement. Actual write access still comes from permission policy.

## Workflow modes

`AgentTemplate.workflow(meta)` returns the runtime behavior object for the selected mode:

- `auto`: `{ "autonomous": true, "prompt": false, "review_tools": false, "review_state": false }`. Run the normal autonomous prompt loop.
- `manual`: `{ "autonomous": false, "prompt": true, "review_tools": true, "review_state": true }`. Wait for explicit user direction before material actions.
- `supervision`: `{ "autonomous": true, "prompt": false, "review_tools": true, "review_state": true }`. Plan and inspect freely, but escalate tool use and state-changing work for review.

## Permission modes

`AgentTemplate.permission(meta)` returns the consumable permission profile for the selected mode:

- `strict`: policy `inherit`; inherit project defaults when `inherit_permissions` is true, ignore `allowed_tools`, and apply `denied_tools`.
- `lax`: policy `allow`; inherit allow-by-default behavior when `inherit_permissions` is true, ignore `allowed_tools`, and apply `denied_tools`.
- `custom`: policy `custom`; use `allowed_tools` and `denied_tools` as the author-defined permission profile, with inheritance controlled by `inherit_permissions`.

## Minimal template

```json
{
  "id": "coder",
  "name": "Coder Agent",
  "persona": "Write and verify focused code changes.",
  "description": "A coding agent for implementation tasks."
}
```

## Full template

```json
{
  "id": "reviewer",
  "name": "Reviewer Agent",
  "persona": "Review code for correctness, regressions, and missing tests.",
  "description": "A review agent for high-signal code review.",
  "entry": {
    "primary": false,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "code_review",
    "tags": ["review", "correctness", "tests"],
    "cost": "medium",
    "writes": false
  },
  "model_preference": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514"
  },
  "workflow_mode": "supervision",
  "allowed_tools": ["read", "grep", "bash"],
  "denied_tools": ["edit"],
  "inherit_permissions": true,
  "permission_mode": "custom"
}
```

## Packaged Agent Entries

Packaged agents should use these entry/capability shapes:

| Agent | Entry | Capability |
|---|---|---|
| `build` | primary, delegable, mentionable, default | implementation; writes true; cost medium |
| `plan` | primary, delegable, mentionable, not default | planning and analysis; writes false; cost low |
| `general` | not primary, delegable, mentionable | general research and bounded work; writes true; cost medium |
| `explore` | not primary, delegable, mentionable | code search and pattern discovery; writes false; cost low |
| `compaction` | hidden, not delegable, not mentionable | system compaction; writes false; cost low |
| `title` | hidden, not delegable, not mentionable | system title generation; writes false; cost low |
| `summary` | hidden, not delegable, not mentionable | system summary generation; writes false; cost low |
| `sisyphus` | primary, delegable, mentionable, default candidate | orchestration and implementation oversight; writes true; cost high |
| `workflow-runner` | primary, delegable, mentionable, not default | durable workflow DAG orchestration and recovery decisions; writes true; cost high |
| `hephaestus` | primary, delegable, mentionable | deep autonomous implementation; writes true; cost high |
| `prometheus` | primary, delegable, mentionable | plan building; writes markdown/plans only by convention; cost high |
| `atlas` | primary, delegable, mentionable | plan execution and coordination; writes true; cost high |
| `sisyphus-junior` | not primary, delegable, mentionable | focused delegated execution; writes true; cost medium |
| `oracle` | not primary, delegable, mentionable | architecture and technical advice; writes false; cost high |
| `librarian` | not primary, delegable, mentionable | external docs and source research; writes false; cost low |
| `metis` | not primary, delegable, mentionable | pre-planning consultation; writes false; cost medium |
| `momus` | not primary, delegable, mentionable | plan review; writes false; cost medium |
| `multimodal-looker` | not primary, delegable, mentionable | media interpretation; writes false; cost low |

## Implementation Requirements

1. Schema validates `entry` and `capability`, including defaults.
2. Loader resolves `mode` aliases into explicit `entry` flags when present.
3. Registry and `/agent` return `entry` and `capability`.
4. Default-agent selection uses `entry.primary`, `entry.default`, and `entry.hidden`.
5. UI and autocomplete filtering use independent entry flags.
6. Delegation candidate generation uses `entry.delegable` and `capability`.
7. Packaged `meta.json` files declare `entry` plus `capability`.
8. Tests cover schema parsing, alias resolution, default-agent rejection, UI/list filtering, mention filtering, and delegation candidate filtering.

Verification:

- Run `bun typecheck` from `packages/opencode`.
- Run `bun test test/agent --timeout 30000` from `packages/opencode`.
- Add focused tests for any TUI/server files changed by entry filtering.
- Regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts` if `/agent` OpenAPI shapes change.
