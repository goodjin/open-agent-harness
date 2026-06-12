# Session Side Panel Topbar Toggle

## User Goal

After the right-side session panel is collapsed, the UI must still expose an obvious way to expand it again. Put that control in the top titlebar next to the file-tree button.

## Agreed Scope

- Add a desktop topbar button next to the file-tree button.
- When the right-side panel is open, the button collapses it.
- When the right-side panel is collapsed, the button opens it again.
- Reopening should preserve the current side-panel tab when one exists, and fall back to Review when there is no active tab.
- Keep the existing collapse control inside the right-side panel.
- Mobile tabs are out of scope.

## Implementation Plan

- Extend the session toolbar layout contract test for a topbar side-panel toggle.
- Add a small `toggleSidePanel` handler in `packages/app/src/pages/session.tsx`.
- Add English, Simplified Chinese, and Traditional Chinese labels for expanding the panel.
- Update the UI console module notes with the topbar recovery control.

## Verification Plan

- Run the focused toolbar layout test from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- Run the app smoke test from `packages/app`.
