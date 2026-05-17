# Workflow DSL Implementation Plan

This plan implements `docs/agent-rewrite/06-workflow-dsl-design.md` in small phases.

## Phase 1: Durable DAG Schema

Goal: introduce the target data model without changing all execution behavior at once.

Tasks:

- add workflow run schema with `nodes` instead of only linear `steps`
- add node state schema for `nodes/<id>.json`
- add decision schema for `decisions/*.json`
- add status enums and transition validation
- add DAG validation for duplicate ids, missing dependencies, and cycles
- keep existing step workflow support behind compatibility parsing

Verification:

- schema tests cover valid workflow, invalid node refs, cycles, duplicate ids, and invalid transitions
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
- keep permission guards as runtime checks

Verification:

- integration test runs a linear DAG
- integration test identifies parallel-ready nodes
- scheduler tests prove DSL does not control concurrency
- failure tests pause affected downstream nodes

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

Goal: make agent behavior match the DSL boundary.

Tasks:

- add Planner rules for when to generate workflow
- add Planner rules for required workflow intent fields
- add Worker rules for node-only execution
- add Worker result protocol for `success`, `failed`, `blocked`, and `needs_replan`
- expose assigned node file paths to worker sessions

Verification:

- prompt snapshot tests include Planner workflow rules
- prompt snapshot tests confirm Worker rules do not include workflow generation instructions
- worker integration test updates only the assigned node file

## Phase 6: Decision Handling

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

## Phase 7: UI And API

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
