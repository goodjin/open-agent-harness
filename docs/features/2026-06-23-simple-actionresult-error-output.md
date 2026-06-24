# Simple ActionResult Error Output

## User Goal

When an `ActionResult` tool call fails, the session timeline should use the same compact display as malformed protocol output. The user should see what kind of failure happened and what the model actually submitted.

## Agreed Scope

- Show the error type as `解析结果失败`.
- Show the model's actual submitted output.
- Prefer the captured raw tool input when available, then the parsed input.
- Do not show schema diagnostics, response payload ids, byte counts, metadata dumps, or export controls in the main timeline.
- Keep successful `ActionResult` rendering unchanged.

## Implementation Plan

- Add a small helper to extract simplified `ActionResult` error display data.
- Route errored `ActionResult` tool parts to a compact timeline card before the generic `ToolErrorCard` path.
- Reuse the same simple output styling used by malformed protocol output.
- Add focused helper tests.

## Affected Modules

- `packages/ui/src/components/message-part-protocol.ts`
- `packages/ui/src/components/message-part.tsx`
- `packages/ui/src/components/message-part-protocol.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run focused UI helper tests from `packages/ui`.
- Run `bun run typecheck` from `packages/ui`.
