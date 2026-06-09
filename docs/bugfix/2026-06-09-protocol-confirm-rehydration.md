# Bug Fix: Protocol confirm missing after blocked validation or restart

## 问题描述

- 日期: 2026-06-09
- 严重程度: High
- 影响范围: Protocol runner confirm requests, session timeline request cards

`Protocol: m4_e5_v3_app_shell_e2e (@epic-planner)` 的最后一轮包含 confirm gate，但 UI 没有确认框。排查发现最新 protocol run 被 verifier dependency validation 直接标记为 `blocked`，`actions: 0`，因此没有创建当前 pending question。该会话同时在 `dsl_context.protocol.confirmations` 中保留了多个 `pending` confirmation，但 server 重启后内存态 `QuestionService` 队列为空，`/question` 不会返回它们。

## 根因分析

- 问题位置:
  - `packages/opencode/src/session/runner.ts`
  - `packages/opencode/src/server/routes/question.ts`
- 原因:
  1. `execute()` 在运行任何 action 前对完整 action graph 做 verifier dependency validation。即使 graph 的第一个 action 是无依赖 `confirm`，后续 verifier 依赖问题也会让整包直接 rejected，导致 confirm gate 被吞掉。
  2. `QuestionService` pending 队列只在内存中，重启后不会从持久化的 `session_protocol_confirmation` / `dsl_context.protocol.confirmations` 恢复 request。

## 修复方案

- `runner.ts`
  - 增加 `confirmGate()` 判断。
  - 当 action graph 以无依赖 human `confirm` 开头时，跳过确认前 verifier 预校验。
  - 兜底执行路径如果发现后续 verifier issue，只运行 confirm gate，并记录 `protocol.confirm.deferred_validation`。
- `question.ts`
  - `/question` 合并内存 pending request 与持久化 `pending` protocol confirmation。
  - 每个 session 只恢复最新 pending confirmation，避免旧确认框抢占 UI。
  - synthetic request id 可解析回 session/run/action；reply/reject 会更新 confirmation 状态并向会话发送明确继续消息。

## 验证步骤

1. ✅ `cd packages/opencode && bun test test/session/runner.test.ts -t "preserves confirmation gate"`
2. ✅ `cd packages/opencode && bun typecheck`

## 设计建议

- `confirm` 是安全恢复边界；后续 `agent` / `tool` 不应在确认前启动。
- 持久化 confirmation 和内存 question queue 需要保持可重建关系，不能只依赖进程内 Deferred。
