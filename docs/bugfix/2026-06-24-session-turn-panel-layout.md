# Bug Fix: Session Turn Panel Layout

## Issue

- Date: 2026-06-24
- Severity: High
- Scope: Session timeline, active question/confirmation UI, composer dock, and long output blocks.

The confirmation and selection UI could be cramped or pushed out of bounds because the full actionable question dock lived in the composer area. Long output blocks also had inconsistent height limits, and some scrollable regions hid scrollbars.

## Root Cause

- `SessionComposerRegion` rendered the full `SessionQuestionDock` above the prompt input, so long question bodies and options competed with the composer input area.
- `timelineQuestionVisible()` hid active pending questions from the timeline surface, forcing the active actionable question back into the composer.
- Output blocks used mixed height limits such as fixed pixel caps or two-screen caps instead of a unified frame taxonomy.
- Several scrollable blocks suppressed scrollbars, making clipped content look like missing content.

## Fix

- Keep active pending questions visible in the timeline active turn panel.
- Remove the full question dock from the composer region.
- Add a timeline todo detail panel for the active turn and keep the composer todo dock collapsed as a compact summary.
- Add `data-scrollable` to dock prompt content so timeline boundary scrolling can recognize nested scroll frames.
- Apply the agreed height limits:
  - Question and confirmation: `500dvh`.
  - Permission: `200dvh`.
  - Delegation and todo: `300dvh`.
  - Text and reasoning: `1000dvh`.
  - Tool, bash, protocol, raw/error output: `300dvh`.

## Verification

- `bun test --preload ./happydom.ts ./src/pages/session/message-timeline.test.ts`

Additional package checks are listed in the feature verification plan.
