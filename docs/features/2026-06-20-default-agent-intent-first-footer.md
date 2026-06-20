# Default And Planner Intent-First Footers

## User Goal

The default agent and planner chain should understand the user's whole task before dispatching work, ask important questions at the start, and then autonomously advance the confirmed task graph instead of stopping after each small task. The same instruction should be reinforced in agent metadata footers so it is appended to every request.

## Agreed Scope

- Add an intent-first and autonomous-continuation reminder to the default agent and planner metadata.
- Keep the reminder in agent metadata through `request_footer.prompt`, not only in global protocol instructions.
- Include Agent Protocol DSL output requirements in the same footer so the model keeps using the native `AgentProtocolOutput` tool.
- Update default agent rules, planner rules, and protocol runtime documentation to describe the behavior.
- Regenerate the built-in agent manifest from source config.

## Implementation Plan

- Update `packages/opencode/config/agents/default/meta.json` with a `request_footer.prompt`.
- Update `packages/opencode/config/agents/{milestone-planner,epic-planner,feature-planner}/meta.json` with planner `request_footer.prompt` values.
- Update default and planner rules with explicit intent-first and autonomous continuation rules.
- Regenerate `packages/opencode/src/agent/builtin.generated.ts`.
- Add or update a focused loader assertion that the generated default agent keeps the footer.
- Document the metadata footer contract in `docs/harness-module/protocol-runtime.md`.

## Affected Modules

- `packages/opencode/config/agents/default/meta.json`
- `packages/opencode/config/agents/default/rules.md`
- `packages/opencode/config/agents/milestone-planner/meta.json`
- `packages/opencode/config/agents/milestone-planner/rules.md`
- `packages/opencode/config/agents/epic-planner/meta.json`
- `packages/opencode/config/agents/epic-planner/rules.md`
- `packages/opencode/config/agents/feature-planner/meta.json`
- `packages/opencode/config/agents/feature-planner/rules.md`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/agent/loader.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run `bun run build`.
- From `packages/opencode`, run `bun test test/agent/loader.test.ts --timeout 30000`.
- From `packages/opencode`, run `bun typecheck`.
