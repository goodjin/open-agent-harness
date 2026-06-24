# Session Turn Panel Layout

## User Goal

Unify the session area layout so every interactive or output frame has a clear owner, height limit, and scrolling rule. Confirmation and selection UI should no longer be split between the composer and timeline, and long text, reasoning, tool output, and active panels should never grow without bounds.

## Scope

- Active user decisions render inside the timeline active turn panel.
- Composer remains the input and compact status area.
- Each timeline frame has an explicit height ceiling.
- Long content scrolls inside its own frame and participates in the timeline scroll boundary handoff through `data-scrollable`.
- The same pending question or confirmation must not render in two actionable locations.

## Frame Taxonomy

| Frame | Category | Height limit | Footer behavior |
| --- | --- | --- | --- |
| `question-panel` | Active Turn Panel | `500dvh` | fixed action footer |
| `confirmation-panel` | Active Turn Panel | `500dvh` | fixed action footer |
| `permission-panel` | Active Turn Panel | `200dvh` | fixed action footer |
| `delegation-panel` | Active / State Panel | `300dvh` | fixed batch action footer |
| `todo-panel` | Turn State Panel | `300dvh` | no decision footer |
| `safety-recovery-panel` | Active Turn Panel | `100dvh` | fixed action footer when actions exist |
| `text-output` | Turn Output Block | `1000dvh` | no footer |
| `reasoning-output` | Turn Output Block | `1000dvh` | no footer |
| `tool-output` | Turn Output Block | `300dvh` | no footer |
| `bash-output` | Turn Output Block | `300dvh` | no footer |
| `protocol-output` | Turn Output Block | `300dvh` | no footer |
| `diff-output` | Turn Output Block | `500dvh` | no footer unless actions are added |
| `raw-output` / `error-output` | Turn Output Block | `300dvh` | no footer |

## Layout Rules

- The timeline is the main scroll container and keeps the viewport-sized session area.
- A timeline frame may scroll internally after reaching its declared height limit.
- Active Turn Panels keep `header`, `body`, and `footer` visually together.
- Active Turn Panel footers are fixed within the panel and cannot be pushed out by long body content.
- Selection controls, option descriptions, notes, and submit/cancel buttons must stay in the same panel.
- Composer must not host the full confirmation or selection UI. It may only show compact status or navigation affordances.
- Any scrollable panel body must include `data-scrollable` so the timeline can distinguish internal scrolling from timeline scrolling.
- Text and reasoning output use 10-screen limits. They should scroll internally once the output exceeds that limit.
- Tool, bash, protocol, raw, and error output use smaller limits because they are supporting evidence blocks.

## Affected Modules

- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/session-confirmation-match.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `packages/ui/src/components/dock-prompt.tsx`
- `packages/ui/src/components/message-part.css`
- `packages/app/src/pages/session/message-timeline.test.ts`

## Implementation Plan

1. Update the timeline visibility rule so active pending questions render in the timeline panel while duplicate protocol confirmations with the same key stay hidden.
2. Remove the full `SessionQuestionDock` from the composer region.
3. Mark dock prompt content as scrollable and keep decision footers fixed by CSS.
4. Apply the agreed height limits to text, reasoning, tool, bash, protocol, question, confirmation, permission, delegation, and todo frames.
5. Update module documentation for the session UI console layout contract.

## Verification Plan

- Run focused timeline/question tests from `packages/app`.
- Run focused question dock tests from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
