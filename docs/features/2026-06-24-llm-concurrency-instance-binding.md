# LLM Concurrency Instance Binding

## Goal

Prevent queued LLM request status updates from being written into the wrong project directory when multiple workspace instances share one server process.

## Scope

- Bind queued LLM concurrency callbacks to the instance that created the queue item.
- Keep queued `rate_limited`, abort cleanup, and post-acquire `running` updates in the originating instance.
- Capture session status save metadata before asynchronous chained writes run.
- Add focused regression coverage for cross-instance queue pumping.

## Affected Modules

- `packages/opencode/src/session/llm-concurrency.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/test/session/llm-concurrency.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Plan

1. Extend queued LLM items with a bound status helper captured from the current `Instance`.
2. Use that helper for every status read/write that can run after a different instance becomes active.
3. Capture project and directory values at `SessionStatus.save()` entry.
4. Verify with a two-directory regression test where one directory releases capacity and pumps another directory's queued request.

## Verification

- Run focused session tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
