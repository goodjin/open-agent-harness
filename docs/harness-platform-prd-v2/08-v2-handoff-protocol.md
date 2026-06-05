# v2 Handoff Protocol

M5 persists assign, handoff, and sync as canonical communication records. The record carries summary, state, evidence, risks, unresolved items, next steps, and refs. It does not copy a raw transcript or large intermediate body.

## Canonical Record

`HandoffRecord` stores:

- `id`, `run_id`, `kind`, `uri`
- `source` and `target`
- `summary` and `state`
- `evidence`, `risks`, `unresolved`, `next`
- `refs`, `resource_refs`, optional `projection_ref`, `trace_ref`, `context_ref`
- `created_at`, `updated_at`

The `uri` uses the M0 ref protocol: `handoff://<handoff_id>`.

## Runtime Boundaries

- `writeHandoff()`: handoff writer. It persists the canonical record, appends `handoff.<kind>`, and updates the `handoffs` projection.
- `normalizeSync()`: sync normalizer. It converts progress updates into `kind: "sync"` records and deduplicates resource refs.
- `handoffContext()`: downstream context bridge. It returns the `handoff_ref`, resource refs, projection ref, trace ref, and context ref, then calls the M3 Context Compiler.

## Ref Behavior

Downstream agents receive refs instead of transcript text:

```txt
handoff_ref + resource refs + projection ref + trace ref + context ref
```

Resource refs use adaptive expansion by default. Handoff, Projection, Trace, and Snapshot refs stay summary-shaped until their own storage contracts provide richer read APIs.

## Examples

- `assign`: planner sends a worker a summary, action evidence, known risks, unresolved questions, and Resource refs.
- `handoff`: worker gives verifier or parent agent current state, result resources, risks, and next verification steps.
- `sync`: child agent reports progress without closing the assignment.
- `repair`: reviewer creates a handoff to a repair worker with failing test report refs.
- `manual switch`: runtime hands current state to a user or different agent target.
- `context limit`: large body remains in Resource; Context Compiler can include summary or defer full expansion.
- `recovery`: restarted runtime reads Handoff records and refs to reconstruct what the next actor needs.
