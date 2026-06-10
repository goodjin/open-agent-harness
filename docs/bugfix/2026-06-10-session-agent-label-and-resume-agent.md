# Bug Fix: Session Agent Label And Resume Agent

## 问题描述

- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: session sidebar / session tree resume message

子会话标题已经包含执行 Agent，例如 `(@build)`，但 sidebar 又从最新 user message 推断出 `(default)` 并追加展示。某些 resume/control message 也会用发起控制动作的 Agent 写入目标会话，导致 child session 的最近 user message agent 与实际执行 Agent 不一致。

## 根因分析

- UI 展示位置: `packages/app/src/pages/layout/sidebar-items.tsx`
- Runtime 写入位置: `packages/opencode/src/server/routes/session.ts`
- Delegation 绑定位置: `packages/opencode/src/session/delegation.ts`

旧 UI 对 child session 仍使用最新 user message 的 `agent` 作为展示标签。tree resume message 模式没有显式传目标会话的绑定 Agent，`SessionPrompt.prompt` 会按默认偏好或发起入口选择 Agent。

## 修复方案

- `SessionDelegation.assign` 为 child session 写入 session 一级 `agent`。
- `/session/tree/resume` 的 message 模式从目标 session 的 `agent` 读取绑定 Agent，并传给 `SessionPrompt.prompt`。
- sidebar 只对 root session 展示从最新 user message 推断的交互 Agent；child session 不再展示这个推断标签。

## 验证步骤

1. ✅ `bun test test/server/session-tree.test.ts`
2. ✅ `bun test test/session/runner.test.ts -t "protocol runner executes native AgentProtocolOutput tool calls"`
3. ✅ `bun typecheck` from `packages/opencode`
4. ✅ `bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts`
5. ✅ `bun typecheck` from `packages/app`
6. ✅ `bun test:e2e:local -- app/smoke.spec.ts`
