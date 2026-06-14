# LLM Request Payload and ActionResult Example

## User Goal

When an `ActionResult` call fails, the runtime should make it easy to inspect the exact provider request and should give delegated workers a concrete native tool-call argument example.

## Agreed Scope

- Store the final LLM provider request payload outside the compact session log row.
- Keep the logs panel lightweight and load the large payload only when the user opens it.
- Include the final active tool list in the payload so native tools such as `ActionResult` are visible.
- Add a concrete `ActionResult` JSON argument example to delegated task prompts and reminders.

## Implementation Plan

1. Add session-scoped payload file helpers to `SessionLog`.
2. Pre-allocate a payload id for each `llm.start` log.
3. Save the transformed provider request params from the LLM middleware under that payload id.
4. Add a session route to read a payload by id with session ownership validation.
5. Add a Payload section to the session log timeline that loads the payload on demand.
6. Update delegated task prompts with worker/verifier `ActionResult` examples.

## Affected Modules

- `packages/opencode/src/session/log.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/pages/session/session-log-timeline.tsx`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run focused session log timeline tests from `packages/app`.
- Run focused opencode typecheck from package directories.
- Regenerate the JavaScript SDK because the session API gained a payload endpoint.
