# Confirm Assignment Management

## Goal

Use the existing protocol confirmation gate to create and update persistent assignments before runtime work starts. Assignment is the task-management record for a session; it is not a new DSL item kind.

## Agreed Scope

- Extend `kind: "confirm"` with optional assignment metadata.
- Use `confirm.plan` as the complete assignment body. Do not duplicate task content inside assignment metadata.
- Persist assignment indexes in SQLite and write full assignment body snapshots to Storage.
- Create root or self assignments only after user confirmation.
- Do not make assignment a hard runtime prerequisite for clarification or exploratory delegation.
- Create child assignments from parent `kind: "agent"` delegation, because the parent action is already the assignment source.
- Keep runtime-owned status/result updates separate from user-confirmed assignment content changes.

## Protocol Shape

```json
{
  "id": "confirm_assignment",
  "kind": "confirm",
  "title": "Confirm assignment",
  "prompt": "Confirm this assignment before execution.",
  "plan": "Complete task content, including goal, scope, constraints, deliverables, and verification.",
  "assignment": {
    "op": "create",
    "target": "self"
  }
}
```

`assignment` only describes the system mutation:

- `op`: `create` or `update`
- `target`: defaults to `self`; a child session id may be used by a parent session when updating a child assignment

## Persistence

SQLite stores queryable assignment state:

- `id`
- `parent_id`
- `session_id`
- `source_type`
- `source_session_id`
- `source_message_id`
- `source_run_id`
- `source_action_id`
- `target`
- `title`
- `status`
- `content_ref`
- `content_hash`
- `content_version`
- `result_ref`
- `result_status`
- timestamps

Storage stores the full content snapshot:

```json
{
  "type": "assignment.content",
  "version": 1,
  "assignment_id": "...",
  "revision": 1,
  "plan": "...",
  "source": {
    "type": "confirm",
    "session_id": "...",
    "message_id": "...",
    "run_id": "...",
    "action_id": "..."
  }
}
```

## Runtime Rules

1. A confirmed `confirm.assignment` creates or updates an assignment and stores a confirmation record.
2. A cancelled confirmation does not mutate assignment state.
3. Replayed confirmations are idempotent by `source_session_id + source_run_id + source_action_id`.
4. Clarification and exploratory delegation may happen before a root assignment exists.
5. After the intent is clear and before starting execution work, the planner should emit an assignment confirmation for final user approval.
6. Child assignment creation happens during delegation from the parent action.
7. Assignment content updates require confirmation; status/result updates are runtime-owned.

## Affected Modules

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/assignment.ts`
- `packages/opencode/src/storage/schema.ts`
- `packages/opencode/migration/*`
- `packages/opencode/test/protocol/schema.test.ts`
- `packages/opencode/test/session/runner.test.ts`

## Verification Plan

- Schema test for `confirm.assignment`.
- Runner test that confirmed assignment creates a record and stores `plan` as content.
- Runner test that cancelled assignment confirmation writes no assignment.
- Runner test or unit coverage that delegation creates a child assignment from the parent agent action.
- Typecheck from `packages/opencode`.
