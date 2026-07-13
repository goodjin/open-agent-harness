# Programming Agent Team And Default Design Review

## User Goal

Position the built-in agent system as a software-development agent team. Keep `default` as the main entrypoint for understanding user intent, but make it assemble the relevant professional agent sessions during solution design so architecture, implementation, testing, compatibility, and risk concerns are discussed before execution.

## Agreed Scope

- Keep `default` as the primary coordinator and prohibit it from directly implementing specialist work when a suitable agent can be delegated.
- Add missing permanent programming roles for architecture design, test authoring, code review, and design review.
- Make existing frontend, backend, database, DevOps, debugging, migration, and specialist review agents available to protocol delegation without making them ordinary primary or mentionable agents.
- Add a design consultation phase before final user confirmation for feature-sized, cross-module, or high-risk work.
- Let `default` and `feature-planner` select professional consultation agents based on the domains and risks found in the request and repository evidence.
- Let planners query existing agents and create hidden, task-specific professional agents when the built-in catalog cannot cover a required specialty.
- Require each consultation prompt to define its professional boundary, concrete questions, evidence expectations, constraints, and output shape.
- Require the coordinating planner to reconcile conflicting advice, distinguish evidence from inference, and produce one coherent design instead of concatenating child responses.
- Require an independent design review before presenting a substantial design for user confirmation.
- Keep small tasks lightweight and avoid mandatory design councils for narrow, low-risk changes.
- Preserve independent verification for every mutating task, with additional specialist review only when the task risk requires it.

## Programming Agent Roles

### Coordination And Planning

- `default`: intent clarification, scale and risk classification, professional consultation orchestration, design synthesis, confirmation, execution graph declaration, and final result synthesis.
- `milestone-planner`: milestone-to-feature decomposition for broad staged work.
- `feature-planner`: feature-to-design-and-delivery decomposition, including professional consultation before implementation tasks are finalized.
- `software-architect`: read-only architecture specialist for module boundaries, data flow, states, interfaces, compatibility, migrations, and technical constraints.

### Investigation And Diagnosis

- `general-investigator`: broad read-only repository investigation and impact discovery.
- `debugger`: read-only reproduction and root-cause diagnosis.
- Task-specific hidden helpers may be created when a required technology specialty is absent from the built-in catalog.

### Implementation

- `frontend`: frontend and UI implementation.
- `backend`: backend, API, authorization, and service implementation.
- `database-agent`: schema, query, transaction, index, and data consistency implementation.
- `devops-agent`: CI, build, deployment, environment, and service configuration implementation.
- `test-engineer`: test authoring and regression coverage implementation.
- `migration-runner`: broad code and API migrations.
- `general-executor`: fallback for bounded cross-domain implementation that has no better specialist.

### Verification And Review

- `verifier`: read-only command execution and validation evidence.
- `code-reviewer`: read-only diff and implementation correctness review.
- `design-reviewer`: read-only review of a synthesized design before user confirmation.
- `technical-reviewer`: high-risk technical tradeoff and architecture advice.
- Existing API contract, security, performance, accessibility, frontend, backend, database, DevOps, migration, and release verifiers are selected only when their risk domain applies.

### Delivery

- `docs-maintainer`: documentation changes when behavior, interfaces, configuration, or workflows require documentation updates.
- `release-runner`: release work only when versioning, artifacts, publishing, or post-release verification is part of the user request.

## Default Design Consultation Flow

1. Understand the user goal, constraints, success criteria, affected details, and unresolved choices.
2. Classify task scale and risk.
3. Inspect a bounded amount of repository context directly, or delegate broad discovery to `general-investigator`.
4. Identify the professional domains involved in the proposed solution.
5. Query the agent catalog and select only the relevant professional consultation agents.
6. Create hidden, read-only task-specific agents when no existing agent covers a material specialty.
7. Dispatch independent consultation sessions in parallel; preserve real dependencies where one consultation needs another result.
8. Require consultation results to include evidence, constraints, risks, options, and recommendations within the assigned domain.
9. Reconcile agreements and conflicts into one coherent design. Do not concatenate child results.
10. Delegate the synthesized design to `design-reviewer` for coverage, consistency, feasibility, scope, and acceptance review.
11. Revise the design from review findings. Request a focused follow-up consultation when evidence cannot resolve an important conflict.
12. Present the reviewed design in the final `confirm` item for direct user-originated execution work.
13. After confirmation, declare the implementation, test-authoring, verification, review, documentation, migration, release, or operations graph.

## Consultation Scaling Rules

- Tiny, low-risk task: skip the design council and delegate directly to one specialist plus one verifier.
- Bug: use `debugger`, then the matching implementation worker, regression coverage when needed, verifier, and code reviewer.
- Single-module feature: use repository investigation when needed, the matching domain specialist, test-engineer consultation, and design review.
- Cross-module feature: use investigation, software architecture, every materially affected domain, testing, and relevant specialist reviewers.
- High-risk work: add the applicable API contract, security, performance, accessibility, data migration, release, or operations reviewer.
- Project or PRD work: preserve project-to-milestone-to-feature decomposition; each feature planner applies this consultation process within its feature boundary.

## Consultation Prompt Contract

Every professional consultation prompt must contain:

- the user goal and current planning boundary;
- relevant repository context and known evidence;
- the exact professional scope assigned to the agent;
- concrete questions the agent must answer;
- constraints and out-of-scope decisions;
- files, modules, contracts, or runtime surfaces to inspect when known;
- expected risks, alternatives, and acceptance implications;
- an explicit instruction to remain read-only during design consultation;
- a structured handoff containing evidence, recommendation, conflicts, assumptions, and unresolved questions.

## Affected Modules

- `packages/opencode/config/agents/default/*`
- `packages/opencode/config/agents/feature-planner/*`
- new agent templates under `packages/opencode/config/agents/`
- existing specialist agent metadata under `packages/opencode/config/agents/`
- `packages/opencode/src/agent/delegation.ts`
- `packages/opencode/src/agent/builtin.generated.ts`
- agent loader, delegation, and prompt integration tests under `packages/opencode/test/agent/`
- protocol runner tests when consultation graph behavior requires focused runtime coverage
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Regenerate built-in agents using the package build script.
- From `packages/opencode`, run focused agent loader, delegation, schema, and prompt integration tests.
- From `packages/opencode`, run focused protocol runner tests for agent catalog and planner prompt behavior when applicable.
- From `packages/opencode`, run `bun typecheck`.
- Inspect the generated agent catalog to confirm every intended specialist is protocol-delegable and excluded from primary/mentionable entrypoints where required.
- Review newly introduced identifiers against the repository naming rules.

## Documentation Impact

- Update `docs/harness-module/protocol-runtime.md` with the programming-team catalog, design consultation lifecycle, dynamic specialist rules, and visibility/delegation boundary.

## Completion Criteria

- `default` and `feature-planner` explicitly perform professional consultation and independent design review for substantial work.
- Small tasks remain lightweight.
- The built-in catalog contains clear architecture, test-authoring, code-review, and design-review roles.
- Existing programming specialists are available to protocol planners without becoming ordinary user-selectable primary agents.
- Mutating work still has independent verification and risk-specific review.
- Focused tests and package type checking pass.
