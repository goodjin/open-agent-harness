# Default Agent Unlimited Concurrency

## User Goal

Make the `default` agent unrestricted at the agent-concurrency layer. The default coordinator should not wait behind the generic planner concurrency fallback.

## Agreed Scope

- Set the bundled `default` agent metadata to the existing unlimited sentinel, `concurrency: -1`.
- Preserve provider/model `concurrency` and `rpm` limits.
- Preserve planner defaults for `milestone-planner`, `epic-planner`, and `feature-planner`.
- Regenerate bundled agent output from source config.
- Add focused regression coverage for the built-in default metadata.
- Update module documentation for the runtime concurrency contract.

## Implementation Plan

1. Add a regression assertion showing the built-in default agent carries unlimited agent-level concurrency.
2. Update `packages/opencode/config/agents/default/meta.json`.
3. Regenerate `packages/opencode/src/agent/builtin.generated.ts`.
4. Update `docs/harness-module/protocol-runtime.md`.
5. Verify with focused agent tests and package typecheck.

## Affected Modules

- `packages/opencode/config/agents/default/meta.json`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/agent/loader.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- `bun test test/agent/loader.test.ts --timeout 30000`
- `bun test test/protocol/agent-concurrency.test.ts --timeout 30000`
- `bun typecheck`
