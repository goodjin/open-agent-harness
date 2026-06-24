# Bug Fix: ActionResult Worker Role Misclassified As Verifier

## Problem

- Date: 2026-06-22
- Severity: High
- Scope: delegated Agent Protocol worker handoff

A delegated worker child session could finish with a successful native `ActionResult` tool call, but the parent protocol graph still treated that worker action as unfinished. The user-visible symptom was that the parent received only a generic child-completed continuation and later actions stayed blocked.

## Root Cause

`LLM.attach()` registered the generic `ActionResult.Schema` for every delegated child. That union tries the verifier branch first, so a worker retry that accidentally includes `target_action_id` can be normalized and stored as `role: "verifier"`.

When the stored result is verifier-shaped, dependency routing does not count it as completion of the worker action. In the observed case, the result self-targeted the same action id, so `update_roadmap_h5_h6_h7_h8_status` remained unfinished even though the worker output had been delivered to `completed_delegations`.

## Fix

- Select `ActionResult.WorkerSchema` for delegated non-verifier agents.
- Select `ActionResult.VerifierSchema` for delegated verifier agents.
- Render request-footer examples from the same assignment-aware context.
- Normalize historical self-target verifier-shaped worker results in `SessionDelegation.complete()` before parent handoff.

## Verification

1. Add regression coverage for a worker child whose stored tool input is self-target verifier-shaped.
2. Run focused session delegation tests from `packages/opencode`.
3. Run focused ActionResult parser tests from `packages/opencode`.

## Related Files

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/request-footer.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/delegation.test.ts`
