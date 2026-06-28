# Agent Catalog Simplification

## User Goal

Simplify the built-in agent catalog around a small set of purpose-based agents, keep retired agents available for historical sessions as hidden templates, show each session's bound agent as an identity plus persona name, remove the epic planning layer, and let planners create hidden protocol-only agents when the existing catalog is not specific enough.

## Agreed Scope

- Add agent metadata fields for:
  - `identity_name`: user-facing role identity such as `后端开发`.
  - `persona_name`: user-facing person name such as `沈越`.
  - `subtype`: category detail such as `backend`, `review`, or `test`.
- Keep `name` as the existing display name used by agent management and SDK surfaces.
- Show sessions with the combined label `identity_name-persona_name`, falling back to `name` and then `id`.
- Keep the top-level agent `kind` taxonomy as:
  - `planner`
  - `worker`
  - `verifier`
  - `helper`
  - `system`
  - `skill`
- Treat reviewers as `kind: "verifier"` with `subtype: "review"`, not as a top-level kind.
- Keep a small visible catalog:
  - `default`
  - `milestone-planner`
  - `feature-planner`
  - `general-executor`
  - `verifier`
  - `technical-reviewer`
  - `general-investigator`
  - `release-runner`
  - `docs-maintainer`
  - `multimodal-looker`
  - `agent-creator`
- Hide retired or overly specific built-in agents instead of deleting them, so historical sessions can still resolve their bound `session.agent`.
- Remove the planner `epic` layer from current prompt and documentation paths. New planning hierarchy is `Milestone -> Feature -> Work Task`.
- Name planned sessions using derivation prefixes:
  - `M1 ...`
  - `M1-F1 ...`
  - `M1-F1-DEV ...`
  - `M1-F1-TEST ...`
  - `M1-F1-REVIEW ...`
  - `M1-F1-ARCH ...`
  - `M1-F1-RESEARCH ...`
  - `M1-F1-RELEASE ...`
- Let planners query and create agents through managed tools.
- Dynamic agents created through these tools are hidden by default and can be used by protocol packages, not ordinary user selection.
- Dynamic `worker`, `verifier`, and `helper` agents must automatically receive the ActionResult collaboration prompt so parent sessions can collect terminal results reliably.

## Implementation Plan

1. Extend the agent metadata schema with optional `identity_name`, `persona_name`, and `subtype` fields.
2. Add helper logic for formatting an agent label as `identity_name-persona_name`.
3. Update agent generation and save paths so dynamic agents default to hidden, protocol-selectable templates with explicit `kind`, `subtype`, `identity_name`, and `persona_name`.
4. Automatically attach the shared ActionResult request footer to dynamically created `worker`, `verifier`, and `helper` agents.
5. Add query/create protocol-facing tools for managed agents, while keeping legacy generate/save tools compatible.
6. Update built-in agent `meta.json` files with identity and persona names.
7. Hide retired built-in agents by setting their entry to non-primary, non-mentionable, non-default, and hidden. Retired agents should not be ordinary delegation candidates.
8. Keep visible purpose-based agents selectable and mentionable according to their existing role.
9. Remove `epic-planner` from current routing prompts and examples; keep the template hidden for historical sessions.
10. Update protocol runtime docs to record the simplified hierarchy and new naming convention.
11. Update app utilities and session UI surfaces to display the formatted agent label for bound sessions.
12. Regenerate built-in agent artifacts and SDK types if schema changes affect generated clients.

## Affected Modules

- `packages/opencode/src/agent/schema.ts`
- `packages/opencode/src/agent/manage.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/tool/agent.ts`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/config/agents/*/meta.json`
- `packages/opencode/config/agents/*/rules.md`
- `packages/opencode/config/protocol/agent-protocol-v2.md`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/runtime-tools.ts`
- `packages/app/src/utils/agent.ts`
- session list, session header, and child-session display components under `packages/app/src`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run the agent schema and management tests.
- From `packages/opencode`, run focused protocol runner tests that cover delegation and ActionResult result collection.
- From `packages/opencode`, run `bun typecheck`.
- From `packages/app`, run unit tests for agent utilities and any touched session display helpers.
- From `packages/app`, run `bun test:e2e:local -- app/smoke.spec.ts` if session UI rendering changes are implemented.

## Open Implementation Notes

- Hidden historical agents must remain resolvable by `session.agent`.
- Ordinary selection, mention autocomplete, and normal delegation candidate lists must continue to exclude hidden agents.
- Protocol-created dynamic agents may be hidden but delegable, because their visibility boundary is managed by protocol authority rather than ordinary user selection.
- `system` and `skill` dynamic creation should be rejected from planner tools.
