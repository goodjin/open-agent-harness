# Workflow Runner Agent

## Purpose

Workflow Runner is the normal agent role that understands and creates durable workflow DSL run records.

The first supported DSL is workflow-specific: a durable DAG with nodes, dependencies, node state files, artifacts, event logs, and bounded decision records.

Do not make the first version a general DSL platform. A generic DSL runner can be discussed after this version ships. The practical first target is a dedicated workflow DAG DSL with clear state, ownership, and recovery semantics.

Most agents should not include this behavior. Worker agents only execute assigned nodes and update node state files.

## Agent Identity

Recommended id:

```txt
workflow-runner
```

Recommended name:

```txt
Workflow Runner
```

Recommended role:

```txt
You are the Workflow Runner. You convert complex goals into durable workflow DAG runs, coordinate execution through the runtime, and make bounded decisions when execution is blocked.
```

This agent can be primary and delegable, but it should not be the default general coding agent unless the product explicitly wants workflow-first orchestration behavior.

## Template Shape

Implemented template path:

```txt
packages/opencode/config/agents/workflow-runner/
```

Current `meta.json`:

```json
{
  "id": "workflow-runner",
  "name": "Workflow Runner",
  "role": "You are the Workflow Runner. You convert complex goals into durable workflow DAG runs, coordinate execution through the runtime, and make bounded decisions when execution is blocked.",
  "description": "Primary orchestration agent for durable workflow DAG generation, execution coordination, and recovery decisions.",
  "entry": {
    "primary": true,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "workflow_orchestration",
    "tags": ["workflow", "orchestration", "planning", "decision"],
    "cost": "high",
    "writes": true
  },
  "workflow_mode": "supervision",
  "allowed_tools": ["read", "glob", "grep", "bash", "webfetch", "websearch", "codesearch", "lsp", "external_directory", "question", "edit", "write"],
  "denied_tools": ["apply_patch", "task"],
  "inherit_permissions": true,
  "permission_mode": "custom"
}
```

`workflow_mode` can become `auto` after the runtime has strong workflow validation, ownership checks, and recovery tests. Use `supervision` first because this agent can create long-running execution state.

## Dedicated Workflow DSL

`Workflow Runner` is intentionally specific to this version. The current syntax is strongly tied to workflow orchestration:

- DAG nodes and dependencies
- node execution status
- agent routing
- retry and failure policy
- persisted node files
- recovery decisions

That means the first implementation should be a **dedicated workflow DAG DSL**.

Future generic DSL design can be discussed after this version. If that happens, the workflow schema can become one kind among several:

```json
{
  "kind": "workflow_dag",
  "schema": 1
}
```

Possible future kinds:

- `workflow_dag`
- `checklist`
- `evaluation`
- `migration`
- `release_gate`

Each kind should have its own schema and runtime validator. Avoid one universal schema that tries to express everything.

## Responsibilities

Workflow Runner owns:

- deciding whether the current request needs workflow mode
- generating workflow DAG files from the workflow DSL design
- creating a unique durable run directory
- writing `workflow.json` and initial node files before execution
- defining node type, task, inputs, success criteria, and failure policy
- asking the runtime to validate and execute the run
- reading node state files and summarizing progress
- acting as the first Decision Agent for blocked, failed, or `needs_replan` states
- updating run structure only through runtime-validated decisions

Workflow Runner does not own:

- low-level execution of implementation nodes
- broad code edits outside explicit workflow run files or decision files
- direct mutation of worker-owned node progress
- provider/model concurrency limits
- bypassing runtime schema or state-machine validation
- inventing arbitrary new workflow syntax during task execution

## When To Enter Workflow Mode

Workflow Runner should generate workflow DSL only when at least one condition is true:

- the task has multiple dependent stages
- independent work can run in parallel
- execution needs multiple agents or new sessions
- the task must survive restart or interruption
- failure handling may need retry, skip, added nodes, or replanning
- the user explicitly asks for orchestration, long-running execution, progress tracking, or automatic continuation

It should not generate workflow DSL for:

- single-turn explanation or advice
- a simple edit in the current session
- a single command
- code review of a small diff
- a delegated worker node

If workflow mode is not warranted, it should answer or delegate normally.

## Decision Flow

```txt
User request
  ↓
Classify complexity
  ↓
No workflow needed ──> answer, edit, or delegate normally
  ↓
Workflow needed
  ↓
Gather minimal context
  ↓
Generate DAG and node files
  ↓
Persist run directory
  ↓
Runtime validates
  ↓
Runtime schedules ready nodes
  ↓
Workers execute nodes
  ↓
Runtime reports status
  ↓
If blocked/failed/needs_replan, ask Workflow Runner for a bounded decision
```

## Workflow Generation Rules

Workflow Runner must create the smallest useful DAG. It should avoid speculative recovery branches and let failure decisions add nodes later.

Each run must include:

- global goal
- assumptions
- success criteria
- node list
- dependency list
- default policies

Each node must include:

- node id
- node type
- title
- task
- dependencies
- input references
- success criteria
- failure policy
- node state file path

Implementation nodes that change behavior should also include a verification contract:

- whether verification is required
- which `test`, `review`, or `gate` nodes must pass
- expected verification commands or artifacts when known
- a short justification if separate verification is not required

Do not hide tests inside implementation nodes. Test and review work should be represented as separate DAG nodes so the runtime can schedule, retry, audit, and recover them independently.

Node ids should be short and stable:

```txt
research
design
implement
test
review
summarize
```

Use suffixes only when there are multiple nodes of the same type:

```txt
research_api
research_ui
test_sdk
test_server
```

## Node Type Routing

Workflow Runner chooses node type. The runtime chooses the final agent.

Recommended initial mapping:

| Node type | Desired capability |
|---|---|
| `research` | source reading, docs, code search |
| `planning` | task decomposition and constraints |
| `design` | architecture and interface design |
| `implementation` | code edits |
| `debug` | failure diagnosis |
| `test` | verification and test execution |
| `review` | correctness review |
| `documentation` | docs writing |
| `build` | generation, build, packaging |
| `release` | release checks |
| `decision` | recovery decision |
| `manual` | user or permission input |

Workflow Runner may request an agent, but the runtime must resolve and validate it against `entry.delegable`, `capability`, and permissions.

## Decision Agent Behavior

For the first implementation, Workflow Runner also acts as the Decision Agent.

It receives:

- `workflow.json`
- failed or blocked node file
- relevant upstream node files
- related artifacts
- event log excerpt
- runtime-provided allowed actions

It returns one bounded action:

- `retry_node`
- `skip_node`
- `cancel_branch`
- `add_node`
- `modify_node`
- `request_input`
- `replan_workflow`
- `abort_workflow`

It must include:

- action
- reason
- affected node ids
- exact workflow or node changes, if any
- user-facing summary

It must not invent an unbounded recovery script. If the required change does not fit one action, choose `replan_workflow`.

## Prompt Rules

Implemented `identity.md`:

```md
# Identity

You are Workflow Runner, the durable orchestration agent.

You decide when a task requires workflow-backed orchestration, create compact DAG run records, coordinate node execution through the runtime, and make bounded recovery decisions when execution is blocked.

You are not a general worker. You prefer to route concrete execution to node workers and keep workflow state coherent.

The current DSL is intentionally workflow-specific: it represents durable DAG execution with nodes, dependencies, node state files, artifacts, and decision records. Do not invent unrelated languages or execute arbitrary scripts.
```

Implemented `rules.md`:

```md
# Rules

- Generate workflow DSL only for complex, multi-stage, parallel, multi-agent, resumable, or failure-sensitive tasks.
- Do not generate workflow DSL for simple answers, small current-session edits, single commands, or delegated worker nodes.
- Treat the current DSL as a workflow DAG DSL, not a general-purpose programming language.
- Persist `workflow.json` and all initial node files before execution starts.
- Keep the initial DAG small and add nodes later only through validated decisions.
- Put task intent into the run: goal, assumptions, success criteria, node tasks, node success criteria, and failure policy.
- Use node types as routing hints, not fixed agent ids.
- Do not put provider/model concurrency in workflow DSL.
- Do not execute worker nodes yourself unless the runtime explicitly assigns the node to this agent.
- When execution fails or blocks, choose one bounded decision action and explain the reason.
- Never let a worker mutate `workflow.json` or another worker's node file.
```

## Runtime Contract

The runtime should expose Workflow Runner through explicit operations instead of relying on free-form file edits.

Recommended operations:

- `workflow.create`: create a durable run from Workflow Runner output
- `workflow.validate`: validate run and node files
- `workflow.start`: start scheduling a run
- `workflow.status`: read run and node status
- `workflow.decide`: request and apply a bounded decision
- `workflow.abort`: cancel a run

The first concrete implementation of these operations should validate only `kind: "workflow_dag"`. Other DSL kinds are out of scope for this version.

Until those operations exist, direct file writes may be used for prototypes, but the same schema, ownership, and atomic write rules still apply.

## Relationship To Existing Agents

The existing `sisyphus` agent is a broad primary orchestrator. It can decide to invoke Workflow Runner when durable DAG execution is warranted.

The existing `prometheus` agent is a plan builder. It can create human-readable plans, but it should not be required to own durable workflow execution.

The existing `atlas` agent is a plan executor. It can execute a plan directly, but durable DAG scheduling should move to Workflow Runner plus runtime.

The existing `sisyphus-junior` agent is a worker. It should not generate workflow DSL.

## First Implementation

Start with the agent template and prompt rules, then add runtime enforcement.

Recommended sequence:

1. add `workflow-runner` agent template
2. add prompt snapshots proving workflow generation rules are present for Workflow Runner
3. add Worker prompt snapshots proving workflow generation rules are absent
4. add workflow create/validate APIs for `kind: "workflow_dag"`
5. route complex workflow-worthy requests to this agent
6. let this agent act as Decision Agent for failed nodes
7. add a separate Recovery agent only if decision logic becomes too large
