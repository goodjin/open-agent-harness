# State, Event, And Projection Model

## Purpose

This document defines the state model shared by Harness runs, actions, assignments, workflow adapter records, protocol runs, UI projection, and audit.

## Source Of Truth

Accepted events are the normative history. Projections are current operational truth derived from accepted events.

State files, database rows, and adapter-specific JSON files may act as materialized projections, but they must not contradict accepted events.

```txt
Command -> validation -> Event -> Projection -> Trigger/Gate -> next Action/Assignment
```

## Event Envelope

Recommended event shape:

```json
{
  "id": "evt_123",
  "seq": 42,
  "time": "2026-05-27T12:00:00Z",
  "scope": "run",
  "namespace": "project:open-agent-harness",
  "type": "action.completed",
  "actor": {
    "type": "runtime",
    "id": "runtime"
  },
  "run_id": "run_123",
  "action_id": "read_package",
  "data": {},
  "refs": ["artifact://action/read_package/output"],
  "prev": "evt_122"
}
```

Required properties:

- stable id
- monotonic sequence inside the event log
- timestamp
- type
- actor
- scope
- data payload

## Projection Types

Core projections:

- run status
- task/action status
- assignment status
- open decision queue
- gate status
- artifact index
- child session tree
- memory index
- concept state
- UI summary

Projections should be rebuildable from events and stored state. If rebuild fails, runtime should block mutation and surface a repair decision instead of continuing with uncertain state.

## Canonical Status

Use a common status vocabulary across adapters:

| Canonical | Meaning |
|---|---|
| `draft` | Created but not ready for execution. |
| `ready` | Valid and schedulable. |
| `running` | Currently executing. |
| `waiting_user` | Waiting for user/Owner input. |
| `waiting_permission` | Waiting for approval. |
| `blocked` | Cannot continue without decision or missing prerequisite. |
| `failed` | Execution failed. |
| `completed` | Finished successfully. |
| `cancelled` | Runtime/user cancelled before completion. |
| `aborted` | Run intentionally terminated as final state. |

Adapter mappings:

- workflow `success` -> `completed`
- workflow `needs_decision` -> `blocked` with `reason: "needs_decision"`
- workflow `needs_replan` -> `blocked` with `reason: "needs_replan"`
- protocol `completed` -> `completed`
- protocol `blocked` -> `blocked`

## Transaction Boundary

For any state-changing command:

1. Validate schema.
2. Validate authority.
3. Validate gate and current projection.
4. Append accepted event.
5. Update projection.
6. Emit subscription/update event.

If any step before event append fails, no state changes. If projection update fails after append, runtime must mark projection stale and require rebuild before accepting further mutations.

## Storage Layers

Recommended storage relationship:

```txt
events.jsonl or event table
  -> projections/
  -> adapter state files
  -> UI/API responses
```

Workflow adapter files live under workflow-specific directories inside the durable Harness run store defined by `docs/harness-protocol/00-harness-governance-protocol.md`.

## V1 Boundary

V1 should define:

- event envelope
- projection summary shape for UI
- status mapping across protocol/workflow/session
- event replay from sequence id
- trace/export shape for protocol runs
