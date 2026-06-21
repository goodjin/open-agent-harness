# ActionResult Fallback Summary

## User Goal

When a delegated child repeatedly fails to submit the native `ActionResult` tool, preserve useful child-session context for the parent instead of handing back only a thin runtime error.

## Agreed Scope

- Keep native `ActionResult` as the normal success and verification routing path.
- If `ActionResult` fails repeatedly, create an independent summary session that reads the failed child transcript and returns plain text.
- Store that text as a fallback delegation result with explicit metadata, not as a native successful `ActionResult`.
- Notify the parent with `failed` or `partial` status so it can retry, ask for confirmation, or produce a repair package.
- Preserve the existing user-confirmed fallback path as the only way to promote reviewed fallback content into a user-approved result.

## Implementation Plan

1. Detect `ActionResult` tool-call failure during delegated child failure handling.
2. Start a child-of-child summary session using the hidden `summary` agent.
3. Prompt the summary session with the child assignment, terminal reason, and bounded transcript evidence.
4. Store the returned plain text with `source: "fallback_summary"` metadata and failure status.
5. Fall back to the existing direct error result if summary creation or execution fails.
6. Document the runtime contract and add focused delegation tests.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run focused delegation tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
