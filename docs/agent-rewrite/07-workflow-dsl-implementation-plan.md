# Workflow DSL Implementation Plan

This plan implements `docs/agent-rewrite/06-workflow-dsl-design.md` in small phases.

The Workflow Runner agent behavior is defined in `docs/agent-rewrite/08-workflow-runner-agent.md`.

## Phase 1: Durable DAG Schema

Goal: introduce the target data model without changing all execution behavior at once.

Tasks:

- add workflow run schema with `nodes` instead of only linear `steps`
- add node state schema for `nodes/<id>.json`
- add decision schema for `decisions/*.json`
- add verification schema for implementation nodes, including `required`, `must_pass`, and expected commands/artifacts
- add status enums and transition validation
- add DAG validation for duplicate ids, missing dependencies, and cycles
- validate that every `verification.must_pass` reference points to a `test`, `review`, or `gate` node
- keep existing step workflow support behind compatibility parsing

Verification:

- schema tests cover valid workflow, invalid node refs, cycles, duplicate ids, and invalid transitions
- schema tests reject verification references to missing or non-verification nodes
- compatibility tests prove existing workflow fixtures still parse or produce a clear migration error

## Phase 2: Durable Run Materialization

Goal: guarantee that every workflow is persisted before execution.

Tasks:

- create unique run directories under `.opencode/workflows`
- materialize static templates into run directories
- write `workflow.json` and initial node files before scheduling
- add atomic JSON write helper with revision checks
- append basic `events.jsonl` records

Verification:

- tests create multiple workflows concurrently without path collision
- restart test reloads a materialized workflow and node files
- stale or missing node files place workflow into `needs_decision`

## Phase 3: DAG Executor

Goal: execute nodes based on dependency readiness while leaving concurrency to the scheduler.

Tasks:

- compute ready nodes from DAG state
- schedule serial and parallel-ready nodes through runtime limits
- update node files for `ready`, `running`, and terminal states
- cancel or pause downstream nodes when required dependencies fail
- prevent workflow completion while required test, review, or gate nodes are incomplete
- route failed verification nodes to deterministic retry or Decision Agent handling
- keep permission guards as runtime checks

Verification:

- integration test runs a linear DAG
- integration test identifies parallel-ready nodes
- scheduler tests prove workflow DSL does not control concurrency
- failure tests pause affected downstream nodes
- gate tests prove implementation success alone does not complete a workflow when required verification is pending

## Phase 4: Agent Routing

Goal: choose agents from node type and capability metadata instead of fixed node agent ids.

Tasks:

- define node type to capability routing table
- resolve requested agents only when allowed
- require `entry.delegable` for worker dispatch
- use `capability.purpose`, `capability.tags`, and `capability.writes` as routing signals
- record resolved agent and session id in node files

Verification:

- routing tests choose implementation, research, review, and test agents by capability
- hidden or non-delegable agents are rejected
- permission profile mismatch blocks dispatch before execution

## Phase 5: Planner And Worker Contracts

Goal: make agent behavior match the workflow DSL boundary.

Tasks:

- add Planner rules for when to generate workflow
- add Planner rules for required workflow intent fields
- add Planner rules that implementation work with behavior changes must include separate test/review/gate nodes or explicitly justify why verification is not required
- add Worker rules for node-only execution
- add Worker result protocol for `success`, `failed`, `blocked`, and `needs_replan`
- expose assigned node file paths to worker sessions

Verification:

- prompt snapshot tests include Planner workflow rules
- prompt snapshot tests include verification node generation rules for implementation tasks
- prompt snapshot tests confirm Worker rules do not include workflow generation instructions
- worker integration test updates only the assigned node file

## Phase 6: Runtime Runner Dispatch

Goal: route only workflow-specific agents through a workflow runner while all other agents keep the existing chat/session loop.

Tasks:

- add an explicit runtime runner discriminator for agents, such as `runner: "chat" | "workflow"`
- default all existing agents to the current chat runner
- map `workflow-runner` to the workflow runner
- update session processing to dispatch by runner without changing normal agent behavior
- make the workflow runner decide whether workflow mode is warranted and fall back to chat behavior when it is not
- pass workflow runner requests through workflow create/validate/start/status operations instead of free-form file mutation
- keep worker node execution on the existing chat runner with a node assignment prompt

Verification:

- session tests prove ordinary agents still use the existing chat path
- workflow-runner tests prove the workflow runner path is selected
- fallback tests prove workflow-runner can answer normally when workflow mode is not warranted
- worker invocation tests prove delegated workers do not receive workflow generation rules

## Phase 7: Decision Handling

Goal: let Planner act as the first Decision Agent for failures and blockers.

Tasks:

- trigger decision request on unresolved `failed`, `blocked`, or `needs_replan`
- pass workflow, failed node, upstream nodes, artifacts, and events to Planner
- validate bounded decision actions
- apply `retry_node`, `add_node`, `modify_node`, `request_input`, `replan_workflow`, and `abort_workflow`
- write validated decisions under `decisions/`

Verification:

- retry test increments attempt and returns node to `ready`
- add-node test updates DAG and materializes the new node file
- invalid decision leaves workflow in `needs_decision`
- abort decision cancels unscheduled downstream nodes

## Phase 8: UI And API

Goal: expose durable workflow runs and node progress.

Tasks:

- update workflow run/list/status endpoints for run directories
- return node statuses and current blockers
- show current node, completed nodes, blocked nodes, and decision-needed state in TUI
- add resume and abort APIs

Verification:

- route tests cover create, status, resume, abort, and restarted runs
- TUI tests show node progress rather than only current step

## Migration Notes

The current MOD-13 implementation can remain as a compatibility layer while the DAG runtime lands.

Migration order:

1. add new schema beside old schema
2. materialize new run directories for new workflows
3. keep old static templates loadable if possible
4. migrate built-in workflows to DAG format
5. remove old step executor after API and TUI use DAG runs

Do not mix old `dsl_context` as the source of truth with new node files. During migration, `dsl_context` may store a pointer to the workflow run id, but durable state should live under the workflow run directory.
