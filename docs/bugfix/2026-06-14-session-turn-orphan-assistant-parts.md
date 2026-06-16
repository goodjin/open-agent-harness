# Bug Fix: Session Turn Assistant Parts Hidden After Follow-Up User Messages

## 问题描述

- 日期: 2026-06-14
- 严重程度: High
- 影响范围: 会话区域 turn 渲染、delegated child session 调试、失败工具调用可见性

`Protocol: impl_10_1_fork_session_shim (@sisyphus-junior)` 和 `Protocol: wave4_switch_component_library` 这类会话中，模型的思考过程、文本输出和工具调用已经写入 `part` 表，但会话区域在结束或继续后不再展示这些内容。

## 根因分析

- 问题位置: `packages/ui/src/components/session-turn.tsx`
- 直接原因: `SessionTurn` 收集某个 user turn 的 assistant message 时，遇到下一个 user message 就停止遍历。
- 实际数据: 有些 assistant message 会在后续 user message 之后继续追加，但它们的 `parentID` 仍然指向原始 user message。
- 结果: 这些 assistant message 有持久化数据，却不属于任何可见 turn。

本地 DB 证据:

- `ses_13c45d326ffeN5HyquRXt7138P`: `151` 个 text part、`187` 个 tool part，其中 `30` 条 assistant message 出现在后续 user 之后但仍挂到旧 `parentID`。
- `ses_13bf423c7ffe57m4qH9E5Og3R2`: `20` 个 text part、`49` 个 tool part，其中 `5` 条 assistant message 出现在后续 user 之后但仍挂到旧 `parentID`。

## 修复方案

- 修改 assistant message 分组规则，以 `assistant.parentID === user.id` 为执行契约。
- 保留只收集当前 user 创建之后 assistant 的约束，避免把历史异常数据提前显示。
- 让会话 filter 的 turn 匹配逻辑复用相同规则，避免 thinking/output/tool filter 下再次隐藏这些内容。

## 验证步骤

1. 添加失败测试，复现 assistant message 被后续 user message 隔开后仍应归属原 user turn。
2. 修改分组逻辑。
3. 运行相关单测、类型检查和 app smoke。

## 相关测试

- `packages/ui/src/components/session-turn.test.ts`
- `packages/app/src/pages/session/message-timeline.test.ts`

## 设计建议

会话 UI 不应从 agent 名称或线性位置推断 action/turn 归属。`parentID` 是 message 层的归属契约；运行过程中的 follow-up、manual continue、重试或错误恢复可能让 message 时间线不再是简单的 user/assistant 交替结构。
