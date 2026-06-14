# Session Model Hot Binding

## User Goal

Changing the model for an existing session should take effect as a hot session binding. Follow-up prompts, protocol recovery, child sessions, and the session tree should not drift back to a historical model such as deepseek just because older messages used it.

## Agreed Scope

- Persist an explicit prompt model selection onto `session.model`.
- Keep runtime continuations and protocol recovery on the session-bound model when it exists.
- Prevent session tree model projection from using historical message model metadata as the visible session model.
- Preserve existing agent model preference and runtime fallback behavior when no explicit session model exists.

## Implementation Plan

- Update `SessionPrompt.prompt()` to write explicit `input.model` into `session.model` before creating the user message.
- Update `SessionPrompt.loop()` to refresh the session each turn and use `session.model` before the queued user message model when resolving the actual execution model.
- Update protocol recovery to resolve the model from `session.model` before falling back to the triggering user message.
- Keep protocol child session model inheritance using the parent `session.model`.
- Make frontend local model scope merge session binding, saved selection, handoff, and last-message fallback by field so partial bindings do not hide saved model state.
- Add regression tests for tree projection, prompt binding, and protocol runtime inheritance.

## Affected Modules

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/index.ts`
- `packages/app/src/context/local.tsx`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/test/server/session-tree.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run focused session prompt tests from `packages/opencode`.
- Run focused session runner tests from `packages/opencode`.
- Run focused session tree server tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
- Run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
- Run `git diff --check`.
