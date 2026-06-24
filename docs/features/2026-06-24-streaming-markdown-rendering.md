# Streaming Markdown Rendering

## User Goal

Assistant text output should stay readable while it is streaming. Partial Markdown should render from the accumulated text snapshot instead of waiting for the final complete answer, and the final answer should still render as normal Markdown when the stream finishes.

## Agreed Scope

- Optimize the Web/App Markdown rendering path used by session text output.
- Keep raw message text unchanged for copy, storage, and logs.
- Treat streaming rendering as a visual snapshot only.
- Make incomplete fenced code blocks readable while tokens are still arriving.
- Avoid protocol, provider, session persistence, and TUI behavior changes.

## Implementation Plan

- Add a streaming mode to the shared Markdown component.
- In streaming mode, render from a derived snapshot that closes an unmatched fenced code block only for display.
- Pass streaming mode from assistant text parts while the text part or assistant message is still unfinished.
- Preserve existing Markdown sanitization, cache, copy buttons, and DOM morphing behavior.
- Document the UI-console rendering boundary.

## Affected Modules

- `packages/ui/src/components/markdown.tsx`
- `packages/ui/src/components/message-part.tsx`
- `docs/harness-module/ui-console.md`

## Verification Plan

- From `packages/app`, run `bun typecheck`.
- From `packages/app`, run `bun test:e2e:local -- app/smoke.spec.ts`.
