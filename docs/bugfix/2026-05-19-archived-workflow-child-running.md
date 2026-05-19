# Bug Fix: Archived Workflow Child Keeps Parent Running

## Problem
- Date: 2026-05-19
- Severity: Medium
- Scope: Workflow runtime status and WebUI session status display

After all visible child sessions appeared complete, the parent workflow session could still show the running icon.

## Root Cause
- Location: `packages/opencode/src/workflow/executor.ts`
- A workflow node can remain `running` while referencing a child session.
- The WebUI hides archived child sessions from the tree and active/total summary.
- If a child session is archived before producing a completed assistant message, `continueRun` recovered it as still waiting instead of resolving the workflow node.
- Result: the parent workflow stayed `active`, so the parent session kept a running status even though no visible child looked unfinished.

## Fix
- Detect archived child sessions during workflow result recovery.
- If the archived child has no completed assistant output, return a workflow child error instead of waiting forever.
- The parent workflow now exits running state and surfaces an error explaining the archived child.

## Verification
1. Added regression test: `continueRun fails an archived running child session`.
2. Ran `bun test test/workflow/executor.test.ts` from `packages/opencode`.
3. Ran `bun typecheck` from `packages/opencode`.

