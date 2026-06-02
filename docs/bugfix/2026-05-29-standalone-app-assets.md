# Bug Fix: Standalone Package Served Remote Web App

## Problem

- Date: 2026-05-29
- Severity: High
- Scope: standalone `open-agent-harness web`

After starting the standalone package, opening the project picker could stay in a loading state and fail to show local directories.

## Root Cause

The server fallback route served `https://app.opencode.ai` when no API route matched. The standalone package did not include the current `packages/app` build output, so the browser loaded a remote OpenCode web app while talking to the local Open Agent Harness API.

This made the frontend and backend versions drift in standalone mode.

## Fix

- `packages/opencode/script/build.ts` now builds `packages/app` and copies `packages/app/dist` into each standalone package under `app/`.
- `packages/opencode/src/server/server.ts` now serves packaged app assets before falling back to the remote web app.

## Verification

1. `bun typecheck` in `packages/opencode`
2. `bun typecheck` in `packages/app`
3. `bun run script/build.ts --single --skip-install` in `packages/opencode`
4. Started the standalone binary on `127.0.0.1:4197`
5. Verified:
   - `/` returns local `Open Agent Harness` HTML
   - `/global/health` returns healthy JSON
   - `/project` returns local projects
   - Browser project picker renders directory rows without console errors
