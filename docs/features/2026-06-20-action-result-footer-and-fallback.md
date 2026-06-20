# ActionResult Footer And Fallback

## User Goal

Reduce repeated empty `ActionResult` tool-call failures in delegated child sessions, and provide a user-confirmed fallback path when the model completed useful work but failed to submit the native result tool.

## Agreed Scope

- Add a generic agent `request_footer` metadata field.
- Store shared footer prompts under `packages/opencode/config/request-footers/`.
- Dynamically append configured footers to each model request without writing them to session history.
- Let footer prompts use simple `{{variable}}` placeholders.
- Bind `ActionResult` repair prompts to the current delegated action.
- Use worker-only or verifier-only `ActionResult` schemas when the delegated context makes the branch known.
- Add a user-confirmed fallback submission flow for repeated `ActionResult` failures.

## Implementation Plan

1. Extend agent metadata loading to accept `request_footer.file` and `request_footer.prompt`.
2. Render request footers at request assembly time and append a transient final user message.
3. Add ActionResult template variables, including current action ids and branch-specific examples.
4. Make ActionResult tool schema branch-aware for delegated worker and verifier sessions.
5. Add an API/runtime path that stores edited user-confirmed fallback text as a delegation result, marks the child `user_completed`, and notifies the parent.
6. Add UI affordance on failed/blocked delegated child sessions to review, edit, and confirm fallback text.

## Affected Modules

- `packages/opencode/src/agent/*`
- `packages/opencode/src/session/*`
- `packages/opencode/config/agents/*/meta.json`
- `packages/opencode/config/request-footers/*`
- `packages/app/src/pages/session/*`
- `docs/harness-module/protocol-runtime.md`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Add failing tests before implementation for footer loading/rendering, transient request append, branch-aware `ActionResult`, and user fallback result storage.
- Run focused tests from `packages/opencode`.
- Run focused app tests from `packages/app` for the fallback UI.
- Run `bun typecheck` from touched package directories if focused tests pass.
