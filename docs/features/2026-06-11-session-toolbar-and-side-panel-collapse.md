# Session Toolbar and Side Panel Collapse

## User Goal

Move the session page global controls out of the session title row and into the top titlebar right area. Add a collapse affordance on the right-side panel so the session timeline can use the reclaimed width.

## Agreed Scope

- Desktop session controls for status, terminal, session tree, review, and file tree belong in the app top titlebar right area.
- The session title row should keep session-local affordances such as parent navigation, title editing, context usage, and the more menu.
- The right-side Review/Logs/Graph/Files/Context panel should include a visible collapse button that closes the whole panel.
- Existing mobile session tabs are out of scope for this change.
- Existing session history windowing and timeline render budget behavior must stay unchanged.

## Implementation Plan

- Add a focused layout contract test for the session toolbar placement and right-panel collapse affordance.
- Move the current `MessageTimeline` title-row tool controls into a topbar portal mounted from the session page.
- Remove the duplicated toolbar controls from the session title row without changing title editing or message rendering.
- Add a compact collapse button to `SessionSidePanel` that calls `view().reviewPanel.close()`.
- Keep topbar review and file tree buttons able to reopen the side panel and select the matching tab.

## Affected Modules

- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-toolbar-layout.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run the focused layout contract test from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
