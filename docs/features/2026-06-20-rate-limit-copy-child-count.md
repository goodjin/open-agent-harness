# Rate Limit Copy and Child Count Repair

## Goal

Clarify session live-status copy so RPM throttling is not described as concurrency, and restore accurate parent-session child totals and completed counts in the sidebar.

## Scope

- Update frontend `rate_limited` copy to distinguish `kind: "rpm"` from `kind: "concurrency"`.
- Preserve lightweight session-tree node statuses when loading child sessions.
- Avoid stale descendant caches when a session list reload needs to refresh child counts.
- Add focused tests for copy and session-tree loading behavior.

## Affected Modules

- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/context/global-sync/session-load.ts`
- `packages/app/src/context/global-sync.tsx`
- `packages/app/src/context/global-sync/types.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `packages/app/src/context/global-sync.test.ts`

## Plan

1. Branch rate-limit live-status copy by `status.kind`.
2. Return status records from lightweight tree loading and merge them into `session_status`.
3. Add a force reload option so explicit session reloads can re-fetch descendants instead of relying on a previously loaded root set.
4. Cover the copy and status-preservation paths with unit tests.

## Verification

- Run focused app tests from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the app smoke test if frontend behavior changes compile and routing surfaces.
