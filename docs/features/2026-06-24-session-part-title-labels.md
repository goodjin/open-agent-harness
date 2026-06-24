# Session Part Title Labels

## User Goal

Session timeline frames should use direct titles that describe the content inside the frame. Reasoning content should not reuse text-output wording, and text content should be labeled as assistant text.

## Agreed Scope

- Reasoning frames are identified by `part.type === "reasoning"`.
- A reasoning frame shows `思考中` while its content can still stream.
- A reasoning frame shows `思考过程` after the reasoning part ends, or after the owning assistant message completes.
- Text frames show `assistant text`.
- Keep the existing streaming and Markdown rendering behavior unchanged.

## Implementation Plan

- Add a small title helper for text and reasoning frame labels.
- Update the text part header to use the assistant text label.
- Update the reasoning part header to use the thinking or thinking-process label based on completion state.
- Cover the label rules with focused tests.

## Affected Modules

- `packages/ui/src/components/session-turn-helpers.ts`
- `packages/ui/src/components/session-turn.test.ts`
- `packages/ui/src/components/message-part.tsx`
- `packages/ui/src/i18n/en.ts`
- `packages/ui/src/i18n/zh.ts`
- `packages/ui/src/i18n/zht.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run `bun test src/components/session-turn.test.ts` from `packages/ui`.
- Run `bun typecheck` from `packages/ui`.
- Run `bun typecheck` from `packages/app`.
