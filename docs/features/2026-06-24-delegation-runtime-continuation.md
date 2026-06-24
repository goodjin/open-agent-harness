# Delegation Runtime Continuation

## User Goal

Optimize runtime delegation so planner-protocol child sessions can return terminal `AgentProtocolOutput` results without requiring `ActionResult`, and so same-run dependent actions are automatically scheduled after satisfied child results.

## Agreed Scope

- Preserve the protocol split:
  - planner/coordinator agents use planner protocol and `AgentProtocolOutput`.
  - action agents use action protocol and `ActionResult`.
- Treat `reply` as terminal but non-satisfying.
- Keep ordinary failed child behavior as fan-in: record failed, blocked, partial, fallback-summary, or terminal child results; wait for already-started siblings; then submit one aggregate handoff to the parent model.
- Do not add generic runtime-created repair actions for ordinary worker failures.

## Implementation Plan

1. Extend delegated result extraction to accept terminal planner-protocol results from protocol-runner children.
2. Map planner terminal results:
   - `success` -> delivered and satisfying.
   - `failure` / `error` -> delivered and failed.
   - `reply` -> delivered and blocked.
3. After storing a child result, evaluate the parent run graph:
   - delivered actions are already completed or terminal.
   - satisfied actions can satisfy downstream dependencies.
   - pending actions are live delegated children.
   - ready actions have all dependencies satisfied and are neither pending nor delivered.
4. Start ready same-run agent actions automatically and keep the parent session in `waiting_child`.
5. Notify the parent model only when there are no pending or ready child actions left.
6. Avoid duplicate starts for actions already pending or delivered.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Add delegation tests for:
  - planner `AgentProtocolOutput.success` handoff.
  - A -> B continuation after A satisfies dependency.
  - A failure/reply does not start B, but existing siblings still fan in.
  - fallback summary remains non-satisfying.
  - no duplicate child for pending/completed action.
- Run focused delegation tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
