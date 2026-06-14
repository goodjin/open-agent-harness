# ActionResult Turn Closure

## User Goal

Delegated child sessions that submit `ActionResult` must stop after the result is accepted. A completed child must not keep issuing model requests, repeat the same ActionResult, or leave the session timeline showing only repetitive completion text.

## Agreed Scope

- Treat a completed native `ActionResult` tool call as a delegated-child terminal signal.
- Allow delegation completion to process assistant messages whose finish reason is `tool-calls` when they contain an `ActionResult` part.
- Mark the associated user turn `done` even when the delegation result was already stored or recovered.
- Set child session status to a terminal status after accepted delegation completion when the current status transition allows it.
- Repair stale delegated child turns before accepting or resuming a prompt when the child already has a terminal `session.action_result`.
- Allow explicit follow-up prompts on completed child sessions; do not treat completion as a prompt-level rejection.
- Keep the change runtime-scoped; do not change model prompts or session UI rendering in this patch.

## Affected Modules

- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Implementation Plan

1. Stop the prompt loop when the assistant response contains a completed native `ActionResult`.
2. Let delegation completion events handle `tool-calls` assistant messages instead of ignoring them.
3. Make `SessionDelegation.complete()` idempotently finish the source turn and settle the child status.
4. Before a child prompt starts or resumes, close any stale source turn referenced by a terminal delegation `completed_message_id`.
5. Add regression tests for `tool-calls` ActionResult completion, idempotent parent notification, and explicit follow-up prompts after terminal delegation results.

## Verification Plan

- `packages/opencode`: `bun test test/session/delegation.test.ts test/session/prompt.test.ts test/session/turn.test.ts`
- `packages/opencode`: `bun typecheck`
