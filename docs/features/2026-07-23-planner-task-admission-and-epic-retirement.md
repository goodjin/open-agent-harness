# Planner Task Admission And Epic Planner Retirement

## User Goal

Make every planner understand the single-Task Session contract before declaring executable work. A planner must create the first Task description, revise the current Task when its boundary changes, or hand a genuinely new Task to a peer Session. Retire `epic-planner` from all new routing while preserving historical Session compatibility.

## Agreed Scope

- Keep the planning chain as `default -> milestone-planner -> feature-planner -> specialist`.
- Require a matching confirmed Task description before formal execution:
  - no bound Task uses `create/self`;
  - the same unchanged Task declares an ordinary executable graph and creates a new Run;
  - a boundary-changing Task revision uses `update/self`;
  - a new independent Task uses `handoff/peer`.
- Keep model-declared routing authoritative. Runtime validates the structured operation but does not reinterpret natural-language intent.
- Reject `create/self` when the Session already owns a Task with the explicit conflict code `session_task_already_bound`; execute no sibling action from the rejected package and ask the model to repair its declaration.
- Allow a first `create/self` confirmation to carry an already reviewed executable graph. Persist the Task, Revision, and workflow before dispatch.
- Keep `update/self` and `handoff/peer` as boundaries that do not execute source-package sibling actions.
- Allow at most one Task assignment declaration in a protocol package.
- Retire `epic-planner` from new routing, delegation policy, and special concurrency behavior.
- Keep the hidden `epic-planner` template installed only so historical Sessions can resolve their bound agent.
- Regenerate the built-in Agent manifest from source configuration.

## Implementation Plan

1. Strengthen the shared planner protocol with a concise Task admission decision table, package atomicity rules, and examples for create, continue, update, and handoff.
2. Align `default`, `milestone-planner`, and `feature-planner` rules with the shared protocol.
3. Mark `epic-planner` rules as retired compatibility behavior and ensure active planners cannot delegate new work to it.
4. Remove `epic-planner` from active planner-chain restrictions and its special concurrency branch.
5. Replace the generic existing-Task create conflict with `session_task_already_bound`.
6. Add focused tests for planner visibility, concurrency, protocol repair, and sibling-action non-execution.
7. Regenerate `packages/opencode/src/agent/builtin.generated.ts`.
8. Update the protocol runtime module documentation.

## Affected Modules

- `packages/opencode/config/protocol/planner-protocol.md`
- `packages/opencode/config/agents/default/rules.md`
- `packages/opencode/config/agents/milestone-planner/rules.md`
- `packages/opencode/config/agents/feature-planner/rules.md`
- `packages/opencode/config/agents/epic-planner/*`
- `packages/opencode/src/agent/delegation.ts`
- `packages/opencode/src/protocol/agent-concurrency.ts`
- `packages/opencode/src/session/task.ts`
- related tests under `packages/opencode/test`
- `packages/opencode/src/agent/builtin.generated.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

1. Run focused Agent delegation, manifest, concurrency, Session Task, and protocol runner tests from `packages/opencode`.
2. Run `bun typecheck` from `packages/opencode`.
3. Confirm generated built-ins keep `epic-planner` hidden and resolvable while excluding it from active delegation.
4. Confirm an existing-Task `create/self` package produces `session_task_already_bound` and executes no sibling action.
5. Confirm direct create, same-Task continuation, update, and new-Task handoff follow the documented route.

## Verification Result

- Agent loader, delegation, concurrency, and Session Task suites: 137 passed.
- Planner assignment prompt integration: 1 focused test passed.
- Existing-Task create atomic rejection: 1 focused Runner test passed.
- `packages/opencode` typecheck passed.
- The full Runner suite still has three pre-existing tool-count failures. The same three failures reproduce unchanged on a clean worktree at the pre-change commit, so they are not attributed to this feature.
- The full prompt-integration suite still has three pre-existing prompt snapshot failures. The same failures reproduce unchanged on a clean worktree at the pre-change commit.
