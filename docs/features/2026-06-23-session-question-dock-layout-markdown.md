# Session Question Dock Layout Markdown

## User Goal

Session confirmation and choice prompts should be readable for long plans or option text. The prompt can grow up to five screens, keep its action buttons visible at the bottom, and render question content as Markdown instead of collapsed plain text.

## Agreed Scope

- Give the session question dock a content-driven height, with five viewport heights as the hard upper bound.
- Keep the footer action area isolated from one shared scrollable content box, including after an option is selected and note/custom-answer fields appear.
- Render question body text through the shared Markdown renderer.
- Render option descriptions through Markdown and avoid truncating raw Markdown before render.
- Keep existing confirm, cancel, single-choice, multi-choice, note, and custom-answer behavior unchanged.

## Out of Scope

- Changing backend question or confirmation semantics.
- Changing protocol `input` or `confirm` schemas.
- Reworking the general dialog system.
- Changing permission prompt layout.

## Implementation Plan

1. Update the question dock text and option description rendering to use Markdown.
2. Preserve full option description strings for Markdown rendering while still showing a collapsed visual preview.
3. Adjust question dock CSS so the dock root is width-limited and capped at five viewport heights while the footer has a stable bottom area.
4. Make the question text, hint, and option list share one scrollable content box so they stay visually grouped.
5. Add focused regression coverage for preserving long Markdown description text.
6. Update UI console module documentation.

## Affected Modules

- `packages/app/src/pages/session/composer/session-question-dock.tsx`
- `packages/app/src/pages/session/composer/session-question-dock.test.ts`
- `packages/ui/src/components/message-part.css`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run the focused session question dock unit test from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the lightweight app smoke check from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
