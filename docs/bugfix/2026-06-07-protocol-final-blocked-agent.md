# Bug Fix: Protocol Final Blocked Agent Stays Running

## Problem

- Date: 2026-06-07
- Severity: Medium
- Scope: Protocol runner final-phase agent delegation

Some protocol sessions showed `act:agent` as the last useful model output, did not create a child session, and later displayed `Protocol final response was empty or malformed.`

## Root Cause

When a final-phase protocol response requested an agent call that was denied by the parent session `task` permission, `delegate()` returned a blocked tool result before `Session.create()`. The run summary was written, but the final assistant message kept the provider finish reason `tool-calls`, so the session could remain visibly active instead of stopping on the blocked summary.

The deeper issue was permission inheritance: protocol delegation checked the parent session permission directly. Planning agents such as `feature-planner` set `inherit_permissions: false`, but their session could still be constrained by parent-session `task` denies.

## Fix

- File: `packages/opencode/src/agent/agent.ts`
  - Add `Agent.permissions()` so effective permissions use the agent's own permissions by default and merge parent session permissions only when `inheritPermissions === true`.
- File: `packages/opencode/src/agent/schema.ts`
  - Change omitted `inherit_permissions` default to `false`.
- Files: `packages/opencode/src/session/runner.ts`, `packages/opencode/src/tool/task.ts`, `packages/opencode/src/workflow/executor.ts`, `packages/opencode/src/session/runtime-tools.ts`, `packages/opencode/src/session/llm.ts`
  - Use effective agent permissions instead of blindly merging or checking parent session permissions.
  - Mark final-phase blocked protocol messages as `finish: "stop"` and persist `time.completed` before writing the blocked summary.

## Verification

- `bun test test/session/runner.test.ts -t "protocol final agent call uses target agent permissions by default"`
- `bun test test/session/runner.test.ts -t "protocol runner executes agent calls in child sessions"`
- `bun test test/agent/permission.test.ts`
- `bun test test/agent/schema.test.ts -t "inherit_permissions"`

## Notes

The fix does not bypass permission checks. If the active agent's effective permission denies `task`, no child session is created; the UI should now show the blocked protocol summary instead of looking stuck. Agents that do not inherit parent permissions can still delegate according to their own `allowed_tools`.
