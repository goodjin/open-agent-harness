# v2 Resource / Document Fabric

M2 moves large model output, tool output, reports, notes, handoff state, and context snapshots into Resource records. Session-facing output carries a title, summary, ref, and suggested next operations instead of copying the full body.

## Resource Index

Each `ResourceRecord` stores:

- `id`, `kind`, `uri`, `summary`
- `producer`, `source_action`, `visibility`
- `evidence`, `lifecycle`
- `media_type`, `size`, `created_at`, `updated_at`

The `uri` uses the M0 ref protocol: `resource://<resource_id>`.

## Storage Layout

```txt
.opencode/harness/runs/<run_id>/resources/
  index/<resource_id>.json
  body/<resource_id>.txt
```

The index is the queryable metadata path. The body path is only loaded by explicit preview, full read, or export operations.

## Session Boundary

Large content is represented in session-facing output as:

```txt
title + summary + resource ref + next operations
```

The raw body stays out of the session part. Later Context Compiler work can choose whether to expand the ref as summary, structured excerpt, or full body.

## Operations

- `write`: create a Resource index record and body file, append `resource.written`, update `resource-index` projection.
- `preview`: return a short body prefix with a truncation flag.
- `full read`: return metadata and full body.
- `redacted export`: return body with simple email redaction.
- `tombstone`: mark lifecycle as `tombstoned`, append `resource.tombstoned`, keep audit metadata.

## Recovery Boundary

M2 recovery is local and file-backed. Resource refs, source action ids, and evidence refs connect resources to M1 Action Graph and Event records. Handoff, Memory, Context Compiler, and UI consumers should reference resources through `resource://` rather than copying body text.
