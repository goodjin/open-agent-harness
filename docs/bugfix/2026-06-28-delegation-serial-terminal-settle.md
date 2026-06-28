# Bug Fix: Delegated Child Terminal Settle Serialization

## 问题描述

- 日期: 2026-06-28
- 严重程度: High
- 影响范围: delegated child `ActionResult` handoff, parent fan-in, `session_result`

父会话收到 `No structured child result was recorded before the session ended.`，但子会话最后的 `ActionResult` 工具调用实际已经完成并写入 `part.data`。

## 根因分析

- 问题位置: `packages/opencode/src/session/delegation.ts`
- 当前有两个自动收口入口:
  - `MessageV2.Event.Updated -> event() -> complete()`
  - `SessionStatus.Event.Status -> statusdone() -> submit() -> close()`
- `complete()` 有 child 级 `busy` guard，会解析 transcript 中的 `ActionResult` / `AgentProtocolOutput`，写 `session_result` 后通知父会话。
- `statusdone()` 绕开 `complete()`，直接进入父会话 `submit()/close()`。当 status 事件先触发或 tool part 读取存在时序差时，`close()` 会合成 synthetic result 并通知父会话。

## 修复方案

- 将 terminal status 自动入口改为先进入同一个 child `complete()` 串行流程。
- 自动 terminal settle 只有在真实结构化结果无法解析且 child 处于失败、中断、超时、取消等非成功终态时，才允许父侧合成 terminal fallback。
- completed / user_completed 的自动终态不再绕过 child result parser 直接合成 `No structured...`。
- 手动 `cancel` / `terminate_with_result` 保留现有显式收口能力。

## 验证计划

1. 添加回归测试: terminal status 触发时，若 child transcript 中已有 completed `ActionResult`，父会话收到真实 result，不收到 synthetic fallback。
2. 调整 completed child 无结构化结果的测试，使其保持 pending / waiting，而不是自动通知父会话。
3. 从 `packages/opencode` 运行定向 `delegation.test.ts`。

## 文档影响

- 更新 `docs/harness-module/protocol-runtime.md` 的 delegated terminal settle 说明。
