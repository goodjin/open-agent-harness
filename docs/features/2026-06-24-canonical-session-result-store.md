# Canonical Session Result Store

## User Goal

Session task results should have one canonical persistent representation. Runtime should not copy full results into parent protocol state, child session context, memory caches, and transcript-derived fallbacks. Parent fan-in, dependency checks, UI, and recovery should use result references and read the canonical record when needed.

## Agreed Scope

- Store raw task-result payloads as files.
- Store only minimal normalized projection in database-backed result records.
- Keep one in-memory parsed-result cache owned by the result store.
- Treat parent `completed_delegations` and child `dsl_context.result` as reference projections, not result sources.
- For `ActionResult`, save the raw accepted tool result payload.
- For `AgentProtocolOutput`, save only terminal result items accepted as task results, not the whole protocol package.
- Keep transcript parsing as a repair/backfill path only.

## Result Boundaries

A `ResultRecord` represents a task execution result, not every model protocol output.

`ActionResult`:

- One accepted `ActionResult` tool call produces one `ResultRecord`.
- Raw file stores the accepted tool input/output and trace location.

`AgentProtocolOutput`:

- Only terminal result items produce `ResultRecord` entries.
- Terminal result kinds are `success`, `failure`, `error`, `reply`, and delegated terminal `answer` / `done` when Runtime treats them as task results.
- Planning, agent dispatch, tool dispatch, confirm, input, and non-terminal answer metadata are not result records.
- Raw file stores only the accepted terminal item plus location metadata such as message id, part id, and item index.

Fallback and synthetic results:

- Fallback summary, user-confirmed fallback, cancellation, timeout, and manual partial handoff can produce `ResultRecord` entries with carrier `fallback_summary` or `synthetic`.
- Their raw files store the accepted fallback/synthetic payload and reason.

## Canonical Shape

Database projection:

```ts
type ResultRecord = {
  id: string
  carrier: "action_result" | "agent_protocol_output" | "fallback_summary" | "synthetic"
  status: "completed" | "partial" | "blocked" | "failed" | "waiting_user"
  satisfying: boolean

  session_id: string
  parent_session_id?: string
  child_session_id?: string
  run_id?: string
  action_id?: string
  target_action_id?: string

  raw_ref: string
  summary?: string
  created_at: number
}
```

Raw file examples:

```json
{
  "carrier": "action_result",
  "message_id": "msg_123",
  "part_id": "prt_123",
  "tool": "ActionResult",
  "input": {
    "kind": "action_result",
    "role": "worker",
    "action_id": "impl",
    "status": "success",
    "result": "Implemented renderer."
  },
  "output": "Action result received."
}
```

```json
{
  "carrier": "agent_protocol_output",
  "message_id": "msg_456",
  "part_id": "prt_456",
  "tool": "AgentProtocolOutput",
  "item_index": 3,
  "item": {
    "kind": "success",
    "id": "impl",
    "summary": "Implementation finished.",
    "message": "Files were updated and tests passed."
  }
}
```

## Write Path

1. Runtime accepts a terminal result carrier.
2. Runtime writes the raw payload file.
3. Runtime writes the minimal `ResultRecord` projection.
4. Runtime updates parent pending/completed delegation state with `result_id`.
5. Runtime updates child result projection with `result_id`.
6. Runtime evaluates dependency satisfaction from `ResultRecord.status`, `satisfying`, `action_id`, and `target_action_id`.
7. Runtime notifies parent fan-in using result references and short summaries.

The raw file and DB projection should be written before parent notification or downstream dependency launch.

## Read Path

- Dependency routing reads only DB projection fields.
- Parent fan-in lists read DB projection and short `summary`.
- UI rows read projection plus `result_id`.
- Detailed result views call `ResultStore.getRaw(result_id)`.
- Parent handoff generation calls `ResultStore.parse(result_id)` and uses the store-owned cache.
- No caller should keep a separate parsed result copy outside `ResultStore`.

## Migration Plan

1. Add `SessionResultStore` with `put`, `get`, `getRaw`, `parse`, and `repairFromTranscript`.
2. Make `SessionDelegation.store()` write `ResultRecord` first.
3. Change parent `completed_delegations` to store `result_id`, status, action id, child id, and summary only.
4. Change child `dsl_context.result` to store `result_id` and local display fields only.
5. Move transcript parsing into `repairFromTranscript`.
6. Remove normal runtime reads from parent completed rows, child result payload copies, and transcript scans.
7. Add migration/backfill for existing `session_delegation_result` JSON files and `dsl_context.result` payloads.

## Implementation Notes

Current implementation lives in `packages/opencode`:

- `src/session/session.sql.ts` defines `session_result`.
- `migration/20260624190000_session_result/migration.sql` creates the table and indexes.
- `src/session/result.ts` owns canonical write/read, raw-file access, and parsed-result cache.
- `src/session/delegation.ts` writes the canonical record before parent fan-in or downstream dependency launch.
- `src/session/runtime-tools.ts` reads child result details through `SessionResult.parse(result_id)`.

Parent `completed_delegations` and child `dsl_context.result` now store reference projections with `result_id`, `raw_ref`, status, action ids, target action id, satisfying flag, and summary. They no longer copy `action_result`, `protocol_result`, or validation metadata for new writes.

Compatibility is read-only: old `session_delegation_result` files, old parent rows, old child `dsl_context.result`, and transcript parsing remain as repair/backfill inputs. New writes go through `session_result` plus `session_result_raw/<result_id>.json`.

Raw file behavior:

- `ActionResult` raw stores accepted tool input/output and message/part trace when available.
- `AgentProtocolOutput` raw stores only the accepted terminal item, message/part trace, and `item_index`; it does not store the full `items` array.
- fallback and synthetic raw store the accepted output plus metadata/reason.

## Verification Results

- `bun test test/session/delegation.test.ts`
- `bun typecheck`

## Verification Plan

- Unit tests for each carrier:
  - `ActionResult` raw file plus DB projection.
  - terminal `AgentProtocolOutput` item only.
  - non-terminal protocol items ignored.
  - fallback and synthetic result records.
- Delegation fan-in tests prove parent and child state only keep `result_id`.
- Recovery tests prove completed child with existing `ResultRecord` does not rescan transcript.
- UI tests prove result detail fetches raw payload through `ResultStore`.
