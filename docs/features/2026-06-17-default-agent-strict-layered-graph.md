# Default Agent Strict Layered Graph

## User Goal

The default agent should never collapse broad work into one implementation worker. For any request, it should classify the request by scale, decompose it through the milestone/epic/feature/task hierarchy, declare the full current-layer Agent Protocol graph, and assign the right planner or specialist agent to each unit.

## Agreed Scope

- Strengthen the default agent rules so user wording such as "do everything", "overall progress", or "do not handle one task at a time" means "declare the complete graph", not "send all work to one worker".
- Keep the existing layered hierarchy: project/PRD, milestone, epic slice, feature/capability, implementation task, and verification/review task.
- Update the generated built-in agent manifest after changing the source agent rules.
- Document the behavior in the protocol runtime module.

## Implementation Plan

- Add a hard delegation boundary to `packages/opencode/config/agents/default/rules.md`.
- Make the default role explicit: it coordinates, decomposes, declares graphs, and assigns agents; it does not directly execute implementation work.
- Clarify that every known current-layer unit must be declared in one graph, with planner handoffs used whenever the next layer still needs decomposition.
- Regenerate `packages/opencode/src/agent/builtin.generated.ts` from the agent config.
- Update `docs/harness-module/protocol-runtime.md` with the default-agent routing contract.

## Affected Modules

- `packages/opencode/config/agents/default/rules.md`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/agent/loader.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run `bun run build` to regenerate the built-in agent manifest.
- From `packages/opencode`, run the focused agent loader test that asserts the generated default rules keep the strict layered graph contract.
- From `packages/opencode`, run `bun typecheck`.
