# Bug Fix: ActionResult Empty Payload Forensics

## Problem

- Date: 2026-06-13
- Severity: Medium
- Scope: delegated child sessions using native `ActionResult`

`dispatch_stash_review_worker` repeatedly attempted `ActionResult` with `{}` as the tool input. The UI log showed the schema parse failure, but it did not expose the final provider request payload, making it hard to confirm whether the native tool schema was actually submitted.

## Root Cause

- `llm.start` was logged before `LLM.stream()` late-attached native tools such as `ActionResult`.
- The log row stored only summary counts and the original runtime tool list, not the final provider request params.
- Delegated task prompts described `ActionResult` fields in prose but did not show the model a minimal native tool-call argument example.

## Fix

- Save the final transformed provider request params in a session-scoped payload file.
- Store the payload id in the compact `llm.start` log row.
- Add an on-demand Payload tab in the logs panel.
- Include concrete worker/verifier `ActionResult` examples in delegated task prompts.

## Verification

1. Focused app tests cover the new payload section.
2. Package-level typecheck should confirm route, schema, and UI typing.
3. SDK generation should update the API surface for the payload route.
