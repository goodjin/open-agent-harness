# Planner Delegated Autonomy And Limits

## User Goal

Planner sessions created by a parent session should not ask the user to confirm the same work again. They should execute the delegated planning task directly, generate all known child tasks in one package, and set dependency edges. User-originated planning should still clarify intent and important details first, then advance the whole current-layer graph after confirmation. Planner concurrency and MiniMax RPM settings should also be raised.

## Agreed Scope

- Update default and planner prompt rules so delegated planner sessions treat the parent handoff as execution authorization.
- Keep user-originated planning focused on early clarification, complete graph declaration, and explicit dependencies.
- Reinforce the same behavior in planner request footers.
- Set planner concurrency defaults to `epic-planner=2` and `feature-planner=5`.
- Configure MiniMax RPM to `50` for the MiniMax models used by repo and user config.
- Update focused tests and module documentation.

## Out Of Scope

- Changing the Agent Protocol DSL schema.
- Changing Runtime confirmation item execution semantics.
- Reworking provider/model limiter internals beyond configuration values.
- Migrating historical session state.

## Implementation Plan

1. Update planner rules for default, milestone, epic, and feature layers.
2. Update planner request footers in agent metadata.
3. Add planner concurrency metadata and align runtime fallback defaults.
4. Adjust MiniMax provider/model RPM configuration.
5. Update focused protocol concurrency tests.
6. Document the planner confirmation split and limit defaults.

## Affected Modules

- `packages/opencode/config/agents/default/rules.md`
- `packages/opencode/config/agents/{milestone-planner,epic-planner,feature-planner}/rules.md`
- `packages/opencode/config/agents/{default,milestone-planner,epic-planner,feature-planner}/meta.json`
- `packages/opencode/src/protocol/agent-concurrency.ts`
- `packages/opencode/test/protocol/agent-concurrency.test.ts`
- `opencode.jsonc`
- `/Users/jin/.config/opencode/opencode.json`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run `bun test test/protocol/agent-concurrency.test.ts` from `packages/opencode`.
- Run `bun test test/agent/loader.test.ts` from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
