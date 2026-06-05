# v2 Persistent Action Graph

M1 persists accepted `kind: "act"` records as Action Graph facts. It does not execute actions, create resources, compile context, or decide acceptance quality.

## Stored Records

- `ActionGraph`: run-scoped graph metadata with schema version, status, and timestamps.
- `ActionRecord`: node record with status, dependencies, criteria, failure handling, gate hint, budget, visibility, expected artifact refs, idempotency key, resource locks, cancellation, and retry policy.
- `ActionEdge`: dependency edge from one action id to another.

## Storage Layout

```txt
.opencode/harness/runs/<run_id>/action-graph/
  graph.json
  actions/<action_id>.json
  edges.json
```

## Events And Projection

`action.accepted`, `action_cancel`, and `action_retry` events are appended to the run event log. Runtime rebuilds the `action-graph` projection from stored graph metadata, action records, dependency edges, and events.

The projection exposes:

- `nodes`: persisted action records.
- `edges`: dependency edges.
- `ready`: ready actions whose dependencies are completed.
- `blocked`: blocked actions or actions waiting for dependencies.
- `source_events`: count of run events used as recovery evidence.

## Recovery Boundary

M1 recovery is file-backed and local. Resource Index and Snapshot records are represented only through refs and graph fields in this milestone; M2 and later milestones will attach resource bodies, context snapshots, and richer recovery policy.
