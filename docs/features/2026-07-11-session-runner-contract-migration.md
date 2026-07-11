# SessionRunner Contract Migration

## User Goal

Align stale SessionRunner tests with the current Agent catalog, canonical result projections, handoff rendering, and Protocol parser/retry contract while preserving safety boundaries around textual tool-call output.

## Agreed Scope

- Correct the two dispatch assertions to preserve handler return values.
- Update protocol metadata, unavailable-agent wording, Markdown handoff, and canonical `SessionResult` assertions.
- Replace hidden/non-delegable built-in Agent dependencies with explicit delegable fixtures.
- Replace plain-text worker completion fixtures with native `ActionResult` where satisfaction is required.
- Allow a clean ordinary Markdown answer after one protocol retry when runtime history exists.
- Continue rejecting provider-specific textual tool calls, XML-like tool calls, and textual `AgentProtocolOutput` payloads as ordinary answers.
- Preserve only explicitly supported MiniMax recovery formats and update call-count assertions to the current bounded flow.
- Do not modify final-loop recursion or Workflow synchronization; those belong to separate work packages.

## Implementation Plan

1. Update the six direct stale assertions.
2. Repair the three Agent/child fixtures using explicit registry mocks and native `ActionResult` records.
3. Review each of the seven parser/retry tests against `pseudo()`, invalid native tool handling, and supported MiniMax recovery.
4. Change production parsing only where current behavior violates the agreed textual-tool safety boundary.
5. Run all sixteen targeted tests and nearby parser/retry tests.
6. Update protocol runtime documentation if the accepted parser boundary was previously ambiguous.

## Affected Modules

- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/src/session/runner.ts` if textual-tool safety requires a correction
- `packages/opencode/src/protocol/schema.ts` only if supported compatibility parsing is inconsistent
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run all sixteen contract-migration tests independently or as a focused regex group.
- Run nearby protocol parsing and recovery tests.
- Run `bun typecheck` from `packages/opencode`.
