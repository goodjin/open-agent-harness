# v2 Acceptance Gates

M6 makes acceptance an explicit runtime record. Criteria, policy, evidence, result, reviewer, and repair routing are stored separately from raw transcript.

## Acceptance Record

`AcceptanceRecord` stores:

- `id`, `run_id`
- `target`: Run, Action Graph, Action, Assignment, Workflow node, or Resource ref
- `criteria`
- `policy`
- `required`
- `result`
- `evidence`, `reason`, `reviewer`
- `created_at`, `updated_at`

## Policy Levels

`acceptancePolicy()` can generate:

- `none`
- `auto`
- `test`
- `agent`
- `human`
- `combined`
- `sampled`

Inputs include criteria, risk, side effects, resource scope, artifact type, agent kind, permission, and sample rate.

## Gate Results

Gate results are:

- `approved`
- `changes_requested`
- `needs_evidence`
- `needs_user_decision`
- `blocked`
- `waived`

Recording a result appends an `acceptance.<result>` event and updates the `acceptance-state` projection. `changes_requested` creates a repair assignment with the review reason as context.

## Completion Guard

An Action with criteria cannot be written as `completed` unless every required acceptance record for `action://<action_id>` is `approved` or `waived`. Actions without criteria keep the M1 behavior.

This is the narrow M6 guard. Future Workflow and Run completion paths should reuse the same required-gate check for graph-level and workflow-node targets.
