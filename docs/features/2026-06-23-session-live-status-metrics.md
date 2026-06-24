# Session Live Status Metrics

## User Goal

The session composer live-status line should include compact runtime metrics. While the model is responding, it should show how long the current event has been running and how many bytes have been received. While a request has been sent but no model output has arrived yet, it should show how long the request has been active and the size of the user request. Other live event types should show their elapsed duration when a reliable start time exists.

## Agreed Scope

- Keep the status line in the composer area above the prompt input.
- Derive metrics from existing synchronized session status, messages, message parts, and user-turn metadata.
- Treat sent request size as the user-visible request content bytes, not the final provider payload bytes.
- Show received output bytes for active assistant output from text, reasoning, and completed or errored tool output strings.
- Show elapsed time for active request, assistant output, tool execution, waiting, queued, retry, pause, aborting, and similar live states when timing data is available.
- Avoid backend schema changes and avoid coupling the composer line to session-log payload storage.

## Implementation Plan

- Extend the pure `deriveSessionLiveStatus()` helper to calculate optional metric text.
- Add focused helper tests for output bytes, request bytes, and elapsed durations.
- Render metrics in the existing live-status line without changing the dock ownership.
- Update the UI console module documentation to define the metric source and payload-size boundary.

## Affected Modules

- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `docs/harness-module/ui-console.md`

## Verification Plan

- From `packages/app`, run `bun test src/pages/session/helpers.test.ts`.
- From `packages/app`, run `bun typecheck`.
- From `packages/app`, run `bun test:e2e:local -- app/smoke.spec.ts`.
