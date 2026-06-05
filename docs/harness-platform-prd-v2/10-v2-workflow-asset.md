# v2 Workflow Asset

M7 saves Workflow as a versioned Action Graph Profile. A Workflow asset can be created from a Run, stored under governance, and expanded into a normal Run with Action Graph nodes.

## Workflow Asset

`WorkflowAsset` stores owner, version, source, visibility, timestamps, and a `WorkflowProfile`.

`WorkflowProfile` stores goal, inputs schema, nodes, criteria, failure policy, gate, loop, budget, artifacts, visibility, and handoff ref.

## Run Expansion

`runWorkflow()` creates a normal Run, writes each profile node as an M1 Action, writes a `workflow-run` Projection, and binds M6 Acceptance records for node criteria.

## Recovery

`recoverWorkflowNode()` supports:

- `inspect`: return current action and evidence refs.
- `retry`: move node back to ready.
- `skip`: mark node completed.
- `repair`: create a repair assignment.
- `decision`: create a user decision with retry/skip options.

Future Workflow UI should call these operations instead of mutating graph state directly.
