# Bug Fix: App Smoke Test for Vite Transform Errors

## Problem

- Date: 2026-06-09
- Severity: High
- Scope: `packages/app` Vite dev server and project session route

The frontend dev overlay reported a Vite esbuild transform failure in `packages/app/src/context/global-sync.tsx`. Type checking passed, but the browser still failed to load because esbuild rejected a conditional expression whose branch was an `async` arrow function.

## Root Cause

The code used this shape inside `loadSessions()`:

```ts
const list = base ? async () => ({ data: base }) : (query) => globalSDK.client.session.list(query)
```

TypeScript accepted it, but esbuild parsed the `async` branch incorrectly in this context. A typecheck-only validation missed the browser startup failure.

## Fix

- File: `packages/app/src/context/global-sync.tsx`
  - Replace the conditional `async` arrow expression with a normal `async` callback and early return.
- File: `packages/app/e2e/app/smoke.spec.ts`
  - Add a lightweight app smoke test that opens a seeded project session route, checks the prompt renders, and fails if a Vite transform overlay appears.
- File: `AGENTS.md`
  - Require `bun test:e2e:local -- app/smoke.spec.ts` as the minimum end-to-end check after frontend changes under `packages/app`.

## Verification

- `bun typecheck`
- `bun test --preload ./happydom.ts ./src/context/global-sync.test.ts ./src/context/global-sync/session-trim.test.ts ./src/pages/layout/helpers.test.ts`
- `bun test:e2e:local -- app/smoke.spec.ts`
