# Remove Redundant Agents

## User Goal

Agent delegation should not target names such as `hephaestus`, `sisyphus`, `atlas`, or `prometheus` that do not describe their behavior. Redundant compatibility agents should be removed instead of renamed or retained when current planner, helper, worker, and verifier agents already cover the behavior.

## Agreed Scope

- Remove redundant package agent templates whose behavior overlaps with current explicit agents.
- Keep the current clear role split:
  - planners decompose work,
  - helpers investigate or gather context,
  - workers implement bounded tasks,
  - verifiers review or validate without writing.
- Do not introduce new broad fallback workers such as `end-to-end-delivery-worker` or `bounded-implementation-worker`.
- Route broad or unclear work through existing planners and clear agents such as `general-investigator`, `general-executor`, `general-executor-verifier`, and domain-specific workers/verifiers.

## Implementation Plan

- Delete package templates for redundant legacy or unclear agents:
  - `hephaestus`
  - `hephaestus-verifier`
  - `sisyphus`
  - `sisyphus-verifier`
  - `sisyphus-junior`
  - `sisyphus-junior-verifier`
  - `atlas`
  - `atlas-verifier`
  - `prometheus`
  - `general`
  - `plan`
  - `requirements-clarifier`
- Update protocol examples and tests that reference deleted package agents.
- Update module documentation to record the agent catalog cleanup and the routing replacement.
- Regenerate `packages/opencode/src/agent/builtin.generated.ts` from the package agent config.

## Affected Modules

- `packages/opencode/config/agents/`
- `packages/opencode/config/protocol/agent-protocol-v2.md`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/agent/loader.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run `bun run build` to regenerate the built-in agent manifest.
- From `packages/opencode`, run `bun test test/agent/loader.test.ts`.
- From `packages/opencode`, run focused protocol runner tests that had old agent references if needed.
- From `packages/opencode`, run `bun typecheck`.
