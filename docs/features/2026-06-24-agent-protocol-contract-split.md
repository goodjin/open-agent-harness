# Agent Protocol Contract Split

## User Goal

Split model-facing agent protocol instructions into two isolated contracts:

- planner protocol for protocol-runner planner/coordinator agents that emit `AgentProtocolOutput`.
- action protocol for worker/verifier agents that submit delegated handoff results through `ActionResult`.

Clarify that `reply` is terminal but does not satisfy the assigned goal or downstream dependencies.

## Agreed Scope

- Add a planner-only protocol file for `runner: "protocol"` agents.
- Add an action-only request footer for delegated worker/verifier agents.
- Update built-in agent metadata so each agent category loads only its own protocol contract.
- Keep ordinary child failure behavior as fan-in: failed, blocked, partial, fallback-summary, and terminal child statuses are recorded and aggregated for the parent model after sibling child sessions finish.
- Do not add generic automatic repair scheduling for ordinary failed worker actions.

## Implementation Plan

1. Create `packages/opencode/config/protocol/planner-protocol.md` from the existing Agent Protocol DSL contract, removing worker/verifier `ActionResult` details.
2. Create `packages/opencode/config/request-footers/action-protocol.md` as the worker/verifier handoff contract.
3. Repoint planner/protocol agent metadata from `agent-protocol-v2.md` to `planner-protocol.md`.
4. Repoint action agent metadata from `action-result.md` to `action-protocol.md`.
5. Update `docs/harness-module/protocol-runtime.md` to document protocol-family isolation, `reply` semantics, dependency satisfaction, fan-in, and existing verifier fix-loop boundaries.
6. Regenerate bundled agents and add focused loader coverage.

## Affected Modules

- `packages/opencode/config/protocol/`
- `packages/opencode/config/request-footers/`
- `packages/opencode/config/agents/*/meta.json`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/agent/loader.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the opencode agent build script to regenerate bundled agents.
- Run focused agent loader tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode` if the focused tests or generation touch TypeScript behavior.
