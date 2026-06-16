# Protocol Whitespace Item Recovery

## User Goal

When a model emits an otherwise valid Agent Protocol DSL v2 package but inserts whitespace-only string elements into the top-level `items` array, runtime should ignore those empty elements instead of rejecting the whole package.

## Agreed Scope

- Recover only top-level `items` entries that are strings and trim to an empty value.
- Preserve all real item validation errors.
- Do not modify prompt or message text, including embedded newlines.
- Keep normal protocol packages unchanged.

## Implementation Plan

- Add a focused schema regression test for a v2 package with `"\n"` entries between valid `agent` items.
- Normalize the raw v2 input before schema validation by filtering top-level whitespace-only string items.
- Leave non-empty string items invalid so ambiguous malformed packages remain rejected.
- Document the parser boundary in the protocol runtime module.

## Affected Modules

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/test/protocol/schema.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- From `packages/opencode`, run the focused protocol schema test and confirm it fails before implementation.
- Implement the narrow normalization.
- Re-run the focused protocol schema test.
- Run `bun typecheck` from `packages/opencode`.
