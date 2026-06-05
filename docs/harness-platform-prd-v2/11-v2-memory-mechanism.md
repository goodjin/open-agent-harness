# v2 Memory Mechanism

M8 stores scoped Memory records derived from Resource, Trace, Sync, explicit user save, and Workflow recap refs. Memory is a summarized, evidence-backed fact record, not a raw transcript archive.

## Memory Record

`MemoryRecord` stores:

- `id`, `uri`
- optional `run_id`
- `summary`
- `scope`: run, project, team, global
- `namespace`
- `source_refs`, `evidence_refs`
- `visibility`
- `status`: candidate, current, historical, superseded, rejected
- `freshness`: current, stale, historical
- timestamps

## Promotion

`createMemoryCandidate()` writes candidate records. `promoteMemory()` requires an approved or waived Acceptance record before changing status to `current`.

## Context Use

`compileContext()` expands `memory://` refs as summary records. `memoryContext()` applies scope precedence: current Projection state can exclude historical Memory for the same namespace, with an explicit exclusion reason.

This keeps current run facts ahead of older project/team/global Memory.
