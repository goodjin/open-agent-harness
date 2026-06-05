# v2 Core Object Model

M0 defines shared contracts only. It does not add scheduling, storage, context compilation, resource writing, acceptance routing, or UI behavior.

## Object Categories

| Category | Role | Typical Objects |
|---|---|---|
| fact | Accepted runtime state or durable knowledge. | run goal, action state, memory record |
| view | Rebuildable projection over facts and evidence. | run projection, graph view, context preview |
| evidence | Proof or observation behind a state change. | trace entry, test report ref, review result |
| resource | Addressable content outside transcript. | document, artifact, log, snapshot body |
| context | Runtime-compiled model input contract. | context bundle, included/excluded refs |
| policy | Rules that shape runtime decisions. | workflow profile, visibility rule, acceptance policy |

## Shared Metadata

Every v2 object has `id`, `schema_version`, `category`, `kind`, `producer`, `visibility`, `lifecycle`, `created_at`, `updated_at`, `refs`, and optional `summary` / `data`.

`producer` records the actor that created the object. `visibility` controls whether refs can be expanded. `lifecycle` lets later milestones archive or tombstone objects without deleting their audit trail.

## Reference Protocol

M0 accepts these ref schemes:

```txt
resource://<id>
document://<id>
artifact://<id>
action://<id>
handoff://<id>
trace://<id>
projection://run/<run_id>/current
memory://<id>
snapshot://<id>
```

M0 only validates ref shape. Resolution, authorization, redaction, summary lookup, and expansion belong to later milestones.

## v1 Mapping

| v1 Semantic | v2 Mapping | Notes |
|---|---|---|
| Artifact | resource + evidence | Artifacts become addressable resources and can also serve as evidence for task completion. |
| Context Bundle | context + view | Context is compiled by Runtime and may expose a view explaining included and excluded refs. |
| Memory | fact | Memory is accepted knowledge with scope, namespace, status, refs, and evidence. |
| Workflow | policy + view | Workflow profiles are policies; workflow runs and graph projections are views over facts and evidence. |

This mapping preserves the v1 surface while moving large bodies and long-lived state out of session messages.
