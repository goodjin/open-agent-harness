# Bug Fix: completed session can enter rate_limited

## 问题描述

- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: 已完成会话再次发起请求时，如果 provider/model 并发槽位已满，`SessionStatus.set()` 会抛出 `InvalidTransitionError: completed -> rate_limited`。

## 根因分析

- 问题位置: `packages/opencode/src/session/status.ts`
- 原因: `completed` 在 session 状态机中只允许转到 `idle`、`running`、`completed`、`archived`，漏掉了新请求排队时使用的 `rate_limited`。
- 代码流程: `LLMConcurrency.acquire()` 在并发满时调用 `publish()`，后者把当前 session 状态设为 `rate_limited`。如果上一轮请求已经把 session 标记为 `completed`，状态机拒绝该新请求状态。

## 修复方案

- 修改 `packages/opencode/src/session/status.ts`，允许 `completed -> rate_limited`。
- 修改 `packages/opencode/test/session/status.test.ts`，覆盖“已完成会话的新请求进入限流队列”的路径。

## 验证步骤

1. 运行 `bun test test/session/status.test.ts`。
2. 运行 `bun typecheck`。

## 相关测试

- `packages/opencode/test/session/status.test.ts`

