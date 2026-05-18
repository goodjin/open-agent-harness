# Bug Fix: WebUI Agent List Empty Across Directories

## Problem
- Date: 2026-05-18
- Severity: High
- Impact: WebUI opened projects whose directory differed from the server startup directory could not load `/agent`, leaving the primary agent selector empty.

## Root Cause
- Location: `packages/opencode/src/server/server.ts`
- MOD-17 removed user-facing `workspaceID`, but the server middleware also changed the runtime directory behavior.
- The middleware rejected requests whose `x-opencode-directory` or `directory` query did not match the current server instance directory.
- WebUI creates per-directory SDK clients, so opening another project sent that directory and received a forbidden response before `/agent` could load.

## Fix
- Keep `workspaceID` removed by always providing `workspaceID: undefined`.
- Restore `directory` as the runtime boundary by resolving the request directory and passing it to `Instance.provide`.
- Make WebUI call `app.agents({ directory })` explicitly during directory bootstrap.
- Add a server route test that calls `/agent` through the middleware with `x-opencode-directory`.

## Verification
- `cd packages/opencode && bun test test/server/agent-manage.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/app && bun typecheck`
- `cd packages/app && bun test --preload ./happydom.ts ./src/utils/agent.test.ts ./src/components/prompt-input/submit.test.ts ./src/i18n/parity.test.ts`

## Notes
- The WebUI agent entry filtering fix remains necessary: primary and mentionable lists now honor `entry` metadata with legacy `mode` fallback.
