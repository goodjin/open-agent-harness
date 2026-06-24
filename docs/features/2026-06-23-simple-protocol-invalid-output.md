# Simple Protocol Invalid Output

## User Goal

When a protocol tool call cannot be parsed, the session timeline should show a simple, direct error display. It should not expose a complex diagnostics panel.

## Agreed Scope

- Show the error type as `解析输出失败`.
- Show the model's actual captured output.
- Do not show response payload ids, raw byte counts, metadata dumps, or export controls in this simplified timeline surface.
- Limit the change to malformed protocol output rendered through the internal `invalid` tool.

## Implementation Plan

- Add a small helper that recognizes internal invalid `AgentProtocolOutput` calls and extracts the captured raw model output.
- Register a lightweight `invalid` tool renderer for protocol parse failures.
- Keep non-protocol `invalid` rendering on the existing generic tool path.
- Add focused tests for extraction behavior.

## Affected Modules

- `packages/ui/src/components/message-part-protocol.ts`
- `packages/ui/src/components/message-part.tsx`
- `packages/ui/src/components/message-part-protocol.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run focused UI helper tests from `packages/ui`.
- Run typecheck from the relevant package if available.
