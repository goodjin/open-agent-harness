# Bug Fix: Fallback 摘要证据与 Timeline 可见性

## 问题描述

- 日期：2026-07-13
- 严重程度：High
- 影响范围：委托子会话的异常收口、父会话结果汇聚、会话 Timeline

委托子会话因 `ActionResult` 校验失败而进入 `blocked` 后，运行时虽然会生成并交付 fallback summary，但存在两个问题：

1. fallback 摘要只读取文本 part，忽略失败的 `ActionResult` tool part，可能误报“没有调用 ActionResult”。
2. fallback 结果以内部 delegation 消息和委托投影交付，Timeline 没有显示其摘要及 `partial fallback` 语义，用户容易判断为“没有回传结果”。

## 已确认范围

本次只修复 fallback 摘要证据和 Timeline 展示，不调整 verifier 的 `target_action_id` 绑定策略。

## 根因分析

- `packages/opencode/src/session/delegation.ts` 的 transcript 构造只收集 text part，丢失 ActionResult 的错误状态和校验信息。
- `packages/app/src/pages/session/session-delegations.ts` 的 Timeline 子会话模型没有 fallback、summary、result 交付状态。
- `packages/app/src/pages/session/message-timeline.tsx` 只展示子会话标题、运行状态和 ID，无法区分“运行 blocked”与“结果已按 partial fallback 交付”。

## 修复方案

1. 将失败的 `ActionResult` tool part 以受限、可读的诊断文本加入 fallback transcript。
2. 保留调用确实发生、校验失败原因和失败状态，避免输出完整 provider payload。
3. 扩展 Timeline 委托投影，读取已交付结果的 summary、fallback 和 partial 状态。
4. 在子会话卡片中显示 fallback 标识与摘要，同时保持 verifier 未通过的语义，不把 partial 当作成功。
5. 对旧数据和缺少新字段的记录保持兼容。

## 影响模块

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/`
- `packages/app/src/pages/session/session-delegations.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/*.test.ts`
- `docs/harness-module/`

## 验证计划

1. 后端单元测试覆盖失败 ActionResult 被纳入 transcript，且摘要不再误报未调用。
2. 前端单元测试覆盖 partial fallback 的解析、状态计算和展示数据。
3. 在 `packages/opencode` 运行相关测试与 `bun typecheck`。
4. 在 `packages/app` 运行相关测试、`bun typecheck` 和 `bun test:e2e:local -- app/smoke.spec.ts`。
5. 通过实际会话数据确认 blocked 运行状态与 partial fallback 交付状态可同时被解释。

## 实施结果

- fallback transcript 会记录失败的 `ActionResult` 次数、受限协议字段和校验错误；长 result 等字段只记录类型与长度。
- user-turn child 投影新增有界 `summary` 和明确的 `fallback` 标记。
- Timeline 保留实时 `blocked` 状态，并额外显示 partial fallback 已交付及摘要；普通 partial 不会被标记为 fallback。
- 旧历史可从 `completed_delegations` 按 child session id 补齐交付摘要。

## 验证结果

- `packages/opencode`: `bun test test/session/delegation.test.ts --timeout 30000`，36 项通过。
- `packages/opencode`: `bun typecheck` 通过。
- `packages/app`: delegation helper 测试 15 项通过。
- `packages/app`: `bun typecheck` 通过。
- `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`，1 项通过。
- `git diff --check` 通过。

## 非目标

- 不修复 verifier assignment 缺少 `target_action_id`。
- 不改变 fallback result 的 `satisfying=false` 语义。
- 不自动把 blocked 子会话改写为 completed。
