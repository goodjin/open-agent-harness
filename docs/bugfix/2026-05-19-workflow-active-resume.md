# Bug Fix: Workflow Active Resume Stops Immediately

## 问题描述

- 日期: 2026-05-19
- 严重程度: High
- 影响范围: workflow runner 主会话继续推进

当 workflow 显示 `active Step n/m`，但后台执行器实际已经不在运行时，用户在主会话输入“继续推进”会立即结束，只输出当前 workflow 状态，不会继续执行未完成步骤。

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`
- 原因: workflow runner 读取到已有 workflow `status === "active"` 时直接返回当前状态并 `stop`，没有重新驱动 `WorkflowExecutor`。
- 触发条件: `workflow_start` 后台执行中断、进程重启，或运行态残留在 `dsl_context` 中，导致 persisted state 仍是 `active`，但内存中的后台执行集合已经没有该 run。

## 修复方案

- 修改 `packages/opencode/src/workflow/executor.ts`
  - 新增 `WorkflowExecutor.continueRun`
  - 当 run 仍在当前进程执行时直接返回状态，避免重复执行
  - running node 会在创建子会话后立即持久化 `sessionID`
  - 当 run 是陈旧 active 状态时，优先检查已有 running child session：未完成则等待，已完成则吸收结果；只有没有可恢复子会话时才退回 `pending` 并继续 `advance`
  - workflow 完成/暂停/失败通知由 runtime 直接写入最近的真实用户 turn 下，避免 synthetic-only user message 在主会话中显示为空白轮次
- 修改 `packages/opencode/src/session/runner.ts`
  - workflow runner 遇到 active run 时调用 `continueRun`

## 验证步骤

1. 已添加 stale active workflow 回归测试
2. 已验证 workflow runner 会继续执行残留 running step
3. 已运行相关测试与类型检查

## 相关测试

- `cd packages/opencode && bun test test/session/runner.test.ts`
- `cd packages/opencode && bun test test/workflow/executor.test.ts`
- `cd packages/opencode && bun test test/tool/workflow.test.ts`
- `cd packages/opencode && bun run typecheck`
- `cd packages/app && bun test src/pages/session/helpers.test.ts src/components/settings-agents-helpers.test.ts`
- `cd packages/app && bun run typecheck`
