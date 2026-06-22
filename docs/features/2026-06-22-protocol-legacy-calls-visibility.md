# Protocol Legacy Calls Visibility

## User Goal

Prevent protocol-runner sessions from learning or repeating the legacy `kind: "act"` / `calls` output shape after long-session history replay, while keeping runtime parsing tolerant enough to recover older stored tool calls.

## Agreed Scope

- Remove legacy `kind` / `calls` fields from the model-visible native `AgentProtocolOutput` JSON schema.
- Keep parser compatibility for already-stored or provider-leaked legacy `kind: "act"` packets.
- Stop history slimming from echoing legacy `calls` arrays back into future model context.
- Add focused protocol schema and prompt-history regression coverage.
- Update protocol runtime module documentation.

## Implementation Plan

1. Narrow `AgentProtocol.OutputSchema` to the current `{ version: "2", items }` contract.
2. Adjust `AgentProtocol.parse()` so versioned legacy packets without `items` are handled by the existing flat/legacy conversion path.
3. Change `LLM.slim()` so legacy `act` tool calls are summarized as legacy compatibility output, not as reusable `calls` JSON.
4. Add tests that prove legacy packets remain parseable and that `calls` is no longer exposed in the native tool schema or slimmed history.
5. Document the model-facing/runtime-internal compatibility split.

## Affected Modules

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/test/protocol/schema.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the focused protocol schema tests from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode`.
