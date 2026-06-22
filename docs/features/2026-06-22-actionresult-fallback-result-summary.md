# ActionResult Fallback Result Summary

## User Goal

When a delegated child fails to submit native `ActionResult`, the user-facing diagnostic surface should preserve the raw failure cause, but the parent session should receive a task-result summary.

## Agreed Scope

- Keep raw `ActionResult` failure evidence available for user inspection and debugging.
- Do not send protocol, tool-call, or handoff mechanics as the parent-visible child result.
- Generate a parent handoff summary that focuses on the delegated task result.
- If the child produced useful artifacts or findings before the failed handoff, summarize those for the parent.
- If evidence is incomplete, say what is unverified without describing the `ActionResult` failure as the task result.

## Out of Scope

- Changing the native `ActionResult` schema.
- Changing delegated worker/verifier routing semantics.
- Changing UI layout for failed tool cards.
- Retrying or repairing the model provider's empty tool-call arguments.

## Affected Modules

- `packages/opencode/src/session/delegation.ts`
  - fallback summary prompt
  - original failure metadata preservation
  - fallback behavior when a wrapper error such as `ConflictError` follows a raw `ActionResult` failure
- `packages/opencode/test/session/delegation.test.ts`
  - regression coverage for parent-visible task summary and diagnostic metadata split

## Implementation Plan

1. Add a helper that extracts the latest child `ActionResult` failure evidence from the child transcript.
2. Use that evidence to decide whether automatic fallback summary should run even when the thrown error is a wrapper such as `ConflictError`.
3. Redesign the summary-agent prompt so it asks for result-only task handoff content:
   - original delegated requirement,
   - final result and produced artifacts,
   - verification evidence or confidence level,
   - important findings for continuation,
   - remaining blockers, risks, or next steps.
4. Store raw failure diagnostics in fallback metadata instead of parent-visible output.
5. Keep a fallback text path if summary generation fails, with task-result wording first and diagnostic details in metadata.

## Verification Plan

- Add or update focused delegation tests.
- Run the relevant `packages/opencode` session delegation test from the package directory.
