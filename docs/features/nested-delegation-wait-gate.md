# Nested Delegation Wait Gate

## User Goal

When a delegated planner or worker creates its own child sessions, its parent session must keep waiting until those nested child sessions and verifier gates are finished. Dispatching nested work is not completion.

## Agreed Scope

- Use structured session protocol state to decide whether a delegated child is still waiting.
- Treat `dsl_context.protocol.pending_delegations` and active verifier cycles as wait state.
- Do not mark the delegated child completed or notify its parent while nested work is still pending.
- Let the delegated child continue after nested work completes and require its final `ActionResult` before parent handoff.

## Implementation Plan

- Add a structured pending-work guard to `SessionDelegation.complete()`.
- Log a waiting event instead of relying only on fixed wait text.
- Keep existing `ActionResult` parsing and verifier routing unchanged once nested wait state is clear.
- Add regression coverage for a parent -> feature-planner -> worker nesting flow.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-protocol/04-routing-and-delegation-policy.md`

## Verification Plan

- Run the focused delegation tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
