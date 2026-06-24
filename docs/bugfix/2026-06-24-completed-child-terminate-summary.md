# Bug Fix: Completed Child Terminate Summary

## 问题描述

- 日期: 2026-06-24
- 严重程度: Medium
- 影响范围: 父会话子任务列表中的“终止并汇总”操作

当用户对父会话点击“终止并汇总”时，已经自然完成的子会话也会被改成 `user_completed`。这会丢失 completed 与人工结束之间的语义差异，并让 UI 状态看起来像异常结束。

## 根因分析

- 问题位置: `packages/opencode/src/session/delegation.ts`
- 原因: `terminate_with_result` 分支对所有 pending child 统一执行 `SessionStatus.set(... user_completed ...)`，没有先检查当前子会话是否已经 `completed`，也没有先复用已有 delegation result。

## 修复方案

- 对 `completed` 子会话先查询 canonical handoff、parent completed rows、child `dsl_context.result` 和 native terminal result parts。
- 有结果时直接复用结果并通知父会话，不改子会话状态，不创建 summary session。
- 没有结果时保持子会话 `completed`，再生成 transcript summary。
- 只有未完成子会话继续按原逻辑取消运行并标记 `user_completed`。
- UI 将 `user_completed` 状态点改为成功色 check 图标。

## 验证步骤

1. 运行 delegation 目标测试，覆盖 completed 有结果复用与 completed 无结果总结。
2. 运行 package typecheck。

## 相关测试

- `packages/opencode/test/session/delegation.test.ts`
