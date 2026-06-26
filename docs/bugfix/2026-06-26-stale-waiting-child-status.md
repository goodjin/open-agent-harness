# Stale Waiting Child Status

## User Goal

Opening `Protocol: F1.5 两个扩展 icon 文件就位 + 大小校验 (@feature-planner)` shows the parent session waiting for a child, but the current child session list is empty.

## Diagnosis

The parent session row is persisted as `blocked_child` with message `Waiting for 1 delegated child session.`, while `dsl_context.protocol.pending_delegations` is already empty. The child sessions under that parent are terminal or historical rows, so there is no current child list to render.

This is a stale lifecycle projection, not a frontend list-rendering issue. The UI should not invent a current child list when the parent protocol state has no pending delegation.

## Scope

- Repair `waiting_child` status when loading or restoring session status from DB.
- Treat empty `pending_delegations` as no current child wait.
- Treat pending records whose child rows are already terminal as no live child wait.
- Keep live pending child records as `waiting_child` with a corrected count.
- Add regression coverage for empty pending and terminal pending recovery.

## Affected Modules

- `packages/opencode/src/session/status.ts`
- `packages/opencode/test/session/status.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification

- Run focused session status tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
