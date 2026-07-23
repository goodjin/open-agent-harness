# Bug Fix: Sidebar Terminal Child Count

## 问题描述

- 日期：2026-07-23
- 严重程度：Medium
- 影响范围：会话侧边栏的递归子会话进度
- 当前侧边栏使用 `completed/total`，但分子只统计成功、回复和用户完成。已经进入取消、失败、错误或超时终态的子会话没有计入，导致所有子会话都结束后仍显示 `58/60`。

## 根因分析

- 问题位置：`packages/app/src/pages/layout/helpers.ts`
- 展示位置：`packages/app/src/pages/layout/sidebar-items.tsx`
- `sessionCompleted()` 把失败类状态全部排除，而侧边栏数字实际上需要表达“已结束数量/总数”。
- `terminal_cancelled` 在前端解码为 `aborted`，因此两个因 `stop_duplicate_recovery_dispatch` 结束的重复恢复会话未计入分子。

## 修复方案

- 保持侧边栏的 `结束数/总数` 视觉形式不变。
- 将明确终态计入结束数：
  - `completed`
  - `terminal_reply`
  - `user_completed`
  - `failed`
  - `error`
  - `timeout`
  - `aborted`
- 不把 `blocked`、`interrupted` 或等待状态视为已结束。
- 保留旧消息完成回退逻辑，兼容缺少持久化状态的历史会话。
- 增加递归汇总测试，覆盖取消、失败、错误、超时和仍可恢复状态。

## 验证步骤

1. ✅ 侧边栏 helper 单元测试通过，49 tests passed。
2. ✅ 两个 `aborted` 子会话和 58 个成功类子会话得到 `60/60`。
3. ✅ `blocked` 和 `interrupted` 不进入结束数。
4. ✅ `packages/app` typecheck 通过。
5. ✅ 最小端到端 smoke check 通过。

## 相关模块

- `packages/app/src/pages/layout/helpers.ts`
- `packages/app/src/pages/layout/helpers.test.ts`
- `docs/harness-module/session-sidebar.md`
