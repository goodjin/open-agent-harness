# ActionResult Assignment-Aware Role Parsing

## User Goal

When a delegated worker finishes with `ActionResult`, the parent session should receive a usable worker result even if the model accidentally includes verifier-only fields such as `target_action_id` during a retry.

## Agreed Scope

- Keep worker and verifier `ActionResult` status values shared.
- Keep verifier results routed as verifier results when the delegated agent is a verifier.
- Treat a worker child session as the source of truth for worker result shape.
- Prevent a worker result from being stored as `role: "verifier"` only because the raw tool input included `target_action_id`.
- Preserve existing fallback-summary behavior for repeated malformed `ActionResult` attempts.

## Out of Scope

- Changing the public `ActionResult` field names.
- Replaying or editing existing historical parent sessions.
- Changing verifier gate semantics.
- Changing UI rendering for child result summaries.

## Affected Modules

- `packages/opencode/src/session/llm.ts`
  - select the native `ActionResult` schema from delegation context.
- `packages/opencode/src/session/prompt.ts`
  - derive worker/verifier context from the delegated agent role.
- `packages/opencode/src/session/delegation.ts`
  - normalize already-stored self-target verifier-shaped worker results before parent handoff.
- `packages/opencode/src/session/request-footer.ts`
  - render examples from the same delegation context.
- `packages/opencode/test/session/delegation.test.ts`
  - regression coverage for a worker child that submits a self-target verifier-shaped result.

## Implementation Plan

1. Pass assignment-aware `ActionResult` context into the request footer and LLM tool attachment.
2. Use worker schema for delegated non-verifier agents, so extra verifier fields are ignored rather than selecting the verifier branch.
3. Add a storage-layer guard for historical or already-normalized tool parts where `role: "verifier"` self-targets the same worker action.
4. Add a focused delegation test that reproduces the observed `docs-maintainer` failure mode.

## Verification Plan

- Run the focused session delegation test from `packages/opencode`.
- Run the focused ActionResult parser tests from `packages/opencode`.
