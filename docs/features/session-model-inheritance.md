# Session Model Inheritance

## User Goal

When a child session is created for an agent, use the agent's configured model when it exists. If the agent has no configured model, inherit the parent session model so the child session keeps the same execution identity as its parent.

## Agreed Scope

- Apply the fallback to protocol delegated child sessions.
- Apply the fallback to workflow subagent child sessions.
- Keep agent model preference higher priority than parent session model.
- Keep the current default model fallback when neither the agent nor the parent session has a model.
- Avoid changing unrelated model selector or provider configuration behavior.

## Implementation Plan

- Add focused regression coverage for child session `model` persistence.
- Resolve the protocol child model once and use it both for `Session.create()` and `SessionPrompt.prompt()`.
- Store workflow child `agent` and inherited `model` during child session creation.
- Update the protocol runtime module documentation to record the inheritance rule.

## Affected Modules

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/workflow/executor.ts`
- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/test/workflow/executor.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the focused session runner test from `packages/opencode`.
- Run the focused workflow executor test from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
- Run `git diff --check`.
