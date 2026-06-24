# Bug Fix: Child Session List Refresh

## 问题描述

- 日期: 2026-06-22
- 严重程度: Medium
- 影响范围: App session timeline delegated child-session list

生成子会话后，当前父会话页面不会立即显示子会话列表。用户需要切换一次会话，触发完整父会话重新加载后，列表才出现。

## 根因分析

- 问题位置: `packages/app/src/context/global-sync/event-reducer.ts`, `packages/app/src/context/global-sync.tsx`
- 子会话创建会发 `session.created`，事件里有 `info.parentID`，但当前 turn 的子会话卡片不是从裸 child session 行推导。
- 时间线子会话列表读取父 session 的 `dsl_context.protocol.pending_delegations/completed_delegations`。
- 后端更新父 session 的 `dsl_context` 时会发 `session.updated`，但 SSE 网关会剥掉 `info.dsl_context`，所以前端仅靠事件 payload 无法得到新的 delegation 状态。
- 切换会话会调用完整 `session.get`，因此重新进入后列表才出现。

## 修复方案

- 收到带 `parentID` 的 child `session.created` 时，记录该 parent session 需要刷新。
- 保留现有目录 session-tree cache 失效逻辑。
- 当同一个 parent session 的 `session.updated` 到达时，触发一次完整 `session.get`，把包含 `dsl_context` 的父 session 写回 store。
- 只消费一次待刷新 parent，避免后续无关 `session.updated` 重复拉取。

## 验证步骤

1. ✅ 添加失败测试，确认 child created 后不会自动登记 parent refresh。
2. ✅ 实现事件驱动的 parent refresh。
3. ✅ 运行 focused reducer test。

## 相关测试

- `packages/app/src/context/global-sync/event-reducer.test.ts`
