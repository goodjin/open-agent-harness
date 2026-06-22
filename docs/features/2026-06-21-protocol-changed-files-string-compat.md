# Protocol changed_files String Compatibility

## User Goal

Allow Agent Protocol terminal result items to submit `changed_files` as a plain string as well as a string array. Models often summarize changed files as a single delimited string, and that should not cause an otherwise valid final result to be rejected before it reaches the parent session.

## Agreed Scope

- Accept `changed_files` as either `string[]` or `string` for protocol terminal result shapes.
- Normalize string input into the existing internal `string[]` shape.
- Keep downstream message rendering and protocol result storage array-based.
- Update focused schema tests and protocol runtime documentation.

## Implementation Plan

- Add a reusable text-list coercion schema near the existing protocol text schema.
- Apply it to v2 terminal result fields and flat terminal result fields.
- Update the native `AgentProtocolOutput` JSON schema so tool-call validation allows either array or string.
- Add a regression test for a v2 success item using delimited string input.

## Affected Modules

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/test/protocol/schema.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the focused protocol schema test from `packages/opencode`.
- Confirm the parsed final message still renders changed files in the existing `Changed files: ...` format.
