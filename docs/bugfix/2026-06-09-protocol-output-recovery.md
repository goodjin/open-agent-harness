# Bug Fix: Protocol output recovery on session load

## 问题描述

- 日期: 2026-06-09
- 严重程度: High
- 影响范围: protocol runner child sessions after server restart

When a protocol-runner assistant message had already emitted the native `AgentProtocolOutput` tool call, but the server restarted before the runtime executed the package, opening the session showed only that tool output. Any pending `confirm` question from the package was also lost because the in-memory question queue was never rebuilt.

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`, `packages/opencode/src/server/routes/session.ts`
- 原因: `SessionPrompt.loop` can resume by creating a new assistant turn, but there was no load-time path that inspects an already persisted native protocol output and restores only safe interrupted work.
- 代码流程: message load returned persisted messages; the last assistant message had no protocol summary/context/response part; the persisted `AgentProtocolOutput` was not inspected, so safe waits such as `confirm` were not rebuilt.

## 修复方案

- Added `SessionRunner.recover({ sessionID })` to detect the last assistant protocol output without a protocol completion part.
- Selectively restores safe actions only:
  - `confirm`: restores the pending user confirmation.
  - `agent`: checks whether the child session already exists; resumes/checks it instead of creating a duplicate, and only creates a child when no matching child exists.
  - other actions: do not replay; add a visible recovery hint asking the user to resend or clarify the request.
- Triggers recovery asynchronously from the session messages route so opening a session can recreate pending confirm UI or show the recovery hint.
- Reused the normal protocol settle path only for safe single-action recovery.

## 验证步骤

1. ✅ Added a test that builds an interrupted `AgentProtocolOutput` confirm package and verifies `Question.list()` gets the pending confirmation again.
2. ✅ Added a test that verifies tool actions are not replayed and receive a recovery hint.
3. ✅ Added a test that verifies an existing active child session is not duplicated.
4. ✅ Ran targeted protocol runner tests.
5. ✅ Ran `bun typecheck` from `packages/opencode`.

## 相关测试

- `bun test test/session/runner.test.ts -t "protocol runner executes native AgentProtocolOutput tool calls|recovers unfinished native protocol output|does not replay interrupted non-idempotent tool protocol output|recovers agent protocol output without duplicating an existing active child"`
- `bun typecheck`

## 备注

The full `test/session/runner.test.ts` file still has unrelated pre-existing failures in this dirty worktree, including early `dispatch` expectations before the new recovery test runs.
