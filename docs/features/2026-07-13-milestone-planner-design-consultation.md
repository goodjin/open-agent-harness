# Milestone Planner Design Consultation

## User Goal

Optimize `milestone-planner` with the same professional design consultation approach used by `default` and `feature-planner`, while preserving the milestone layer's responsibility for cross-feature boundaries, shared constraints, dependencies, and delivery order.

## Agreed Scope

- Add a milestone-level professional consultation phase before the feature graph is finalized.
- Identify only the professional domains that materially affect multiple features or the milestone exit state.
- Use read-only consultation sessions for repository discovery, shared architecture, test strategy, API contracts, security, data migration, DevOps, performance, accessibility, release, and other cross-feature risks when applicable.
- Query existing agents first and create a hidden, narrowly scoped, read-only specialist only when no built-in agent covers a material specialty.
- Require consultation prompts to include the milestone goal, repository evidence, professional boundary, concrete questions, constraints, exclusions, risks, and expected handoff.
- Reconcile consultation results into milestone-wide architecture decisions, shared contracts, feature boundaries, dependencies, acceptance signals, integration gates, and rollout constraints.
- Send the synthesized milestone design to `design-reviewer` before declaring feature children.
- Address blocking design findings or request focused follow-up consultation before feature planning continues.
- Pass milestone-wide decisions and constraints into every `feature-planner` handoff so feature sessions do not reopen settled cross-feature decisions.
- Keep `milestone-planner` out of implementation-task, test-task, and code-review-task creation. Those remain the responsibility of `feature-planner`.
- Allow small, low-risk milestones with obvious feature boundaries to skip a full consultation council.

## Milestone Consultation Flow

1. Understand the milestone goal, exit state, constraints, known evidence, risks, and unresolved choices.
2. Identify cross-feature domains and shared decisions.
3. Dispatch only the relevant read-only professional consultations.
4. Run independent consultations in parallel and preserve real dependencies.
5. Synthesize evidence and resolve conflicts into one milestone design.
6. Define shared architecture, contracts, data ownership, integration order, migration and rollout constraints, test strategy, and milestone acceptance signals.
7. Delegate the design to `design-reviewer` for cross-feature coverage, consistency, feasibility, and scope review.
8. Revise blocking findings and request focused follow-up consultation when evidence remains insufficient.
9. Declare the feature graph through sequential `feature-planner` handoffs.

## Feature Handoff Contract

Each feature prompt must include:

- milestone id, goal, and exit state;
- feature goal, scope, and explicit exclusions;
- milestone-wide architecture decisions and shared contracts;
- data ownership and interface boundaries relevant to the feature;
- dependencies on earlier features and integration assumptions;
- milestone-level risks, migration, rollout, observability, and test constraints that apply;
- feature acceptance signals and contribution to milestone acceptance;
- settled decisions that the feature planner must preserve;
- unresolved feature-local questions that the feature planner may decide;
- an instruction to perform feature-level consultation before implementation when applicable.

## Affected Modules

- `packages/opencode/config/agents/milestone-planner/rules.md`
- `packages/opencode/config/agents/milestone-planner/meta.json`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/agent/loader.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Regenerate the built-in agent manifest.
- From `packages/opencode`, run focused loader and delegation tests.
- Assert that milestone planner rules contain consultation, synthesis, design review, scaling, and feature handoff contracts.
- Run `bun typecheck` from `packages/opencode`.
- Run `git diff --check` before commit.

## Completion Criteria

- Substantial milestones use relevant professional consultation before feature decomposition.
- The milestone design receives independent review.
- Feature prompts inherit shared milestone decisions and constraints.
- Small milestones remain lightweight.
- Milestone planner does not create implementation-level work.
