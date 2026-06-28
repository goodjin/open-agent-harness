# Session Sidebar Module

## Scope

The session sidebar renders workspace root sessions, child session trees, status filters, unread/error markers, and tree navigation affordances.

## Data Loading Contract

- Sidebar session loading should prefer root session list plus batched flat descendants.
- Avoid per-root `/session/tree` fan-out for the sidebar. The tree projection aggregates message stats and is more expensive than the sidebar needs.
- Keep session status loaded through the status endpoint and merge it into `session_status`; child session shape should remain a slim `Session.Info` projection.
- Frontend tree construction uses `parentID` and `childMapByParent`.

## Rendering Contract

- The sidebar uses a fixed-row virtual list to reduce mounted DOM rows.
- Virtualization must not assume tree computation is cheap; filtering and expansion should keep derived work bounded where practical.
- Tree guide lines are row-local plus spacer guide lines, so scrolling into the middle of a deep branch still preserves visible ancestry guides.
- Route changes should preserve sidebar scroll position and should not chase the active row.

## Status Filtering

Status filters are category based:

- `active`: running execution such as running, queued, starting, retry.
- `waiting`: user, permission, child, rate-limit, or pause waits.
- `success`: completed, terminal reply, or user completed.
- `failed`: failed, blocked, interrupted, aborted, error, timeout, or unread error marker.
- `stopped`: idle or archived sessions that do not fit another category.

Filtered views keep matching descendants visible by retaining their ancestor path and expanding filtered paths.
