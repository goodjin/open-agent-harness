# Bug Fix: ActionResult Delegation Loop

## 问题描述

- 日期: 2026-06-12
- 严重程度: High
- 影响范围: delegated child sessions using native `ActionResult`

已完成的 delegated child 仍持续发起 LLM 请求。日志中可见同一 child 每几秒重复输出完成声明并再次调用 `ActionResult`，导致请求量异常并触发 provider RPM/TPM 限流。

## 根因分析

- 问题位置:
  - `packages/opencode/src/session/processor.ts`
  - `packages/opencode/src/session/delegation.ts`
  - `packages/opencode/src/session/prompt.ts`
- 原因:
  - native `ActionResult` 完成时 assistant finish reason 是 `tool-calls`。
  - prompt processor 将该结果作为普通工具调用后继续返回 `continue`。
  - delegation message update event 过滤了 `tool-calls`，因此不会把 `ActionResult` 当作完成事件。
  - child 的原始 user turn 仍是 `running`，后续 prompt loop 会反复选择同一 turn。
- 已有 `session.action_result` 的 completed child 如果 turn 未收口，rerun/restore 会重新选择旧 user turn。

## 修复方案

- `processor.ts`: 检测 completed `ActionResult` tool part 后返回 `stop`。
- `delegation.ts`: 允许 `finish=tool-calls` 且包含 completed `ActionResult` 的 assistant 触发 completion。
- `delegation.ts`: completion 幂等补齐 user turn `done/action_result` 和 child terminal status。
- `delegation.ts`: 用 parent run 级 `delegation_notified_runs` 防止 parent resume prompt 重复投递。
- `prompt.ts`: 依赖 turn completion 跳过旧 user turn；显式的新 prompt 仍可创建新 turn。

## 验证步骤

1. ✅ `packages/opencode`: `bun test test/session/delegation.test.ts`
2. ✅ `packages/opencode`: `bun typecheck`
3. ✅ `packages/opencode`: `bun test test/session/prompt.test.ts`

## 相关测试

- `SessionDelegation > ActionResult tool calls close the delegated turn`
- `SessionDelegation > worker ActionResult runs verifier gates serially before notifying parent`
