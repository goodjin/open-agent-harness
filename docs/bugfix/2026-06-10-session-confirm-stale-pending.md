# Bug Fix: Session confirmation stale pending cards

## 问题描述
- 日期: 2026-06-10
- 严重程度: High
- 影响范围: Web session timeline, protocol confirmation flow

`Protocol: Feature: E2 integration test` 这类会话会出现多个确认框。点击确认后可能没有明显反应，另一个会话确认时报错：

`Attempting to access a stale value from <Show> that could possibly be undefined.`

## 根因分析
- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 原因: timeline 直接渲染 `dsl_context.protocol.confirmations` 里的所有 pending 记录，但 `question.list` 实际只恢复每个 session 最新的一个 pending request。旧 pending 记录没有可提交的 request，却仍显示为确认卡。
- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 原因: confirmation card 内部使用 `<Show>` 的函数 accessor，并把 accessor 结果作为响应式 prop 传给 `SessionQuestionDock`。当确认成功后 request 被移除，组件仍可能在异步清理或响应式读取中访问已经失效的 accessor。

## 修复方案
- 新增 `visibleConfirmations()`，按 `messageID + callID` 去重 confirmation retries。
- 当同一轮存在多个 pending confirmation 时，只显示当前 `question.list` 能提交的 request；找不到时显示最新 pending。
- confirmation card 和普通 question card 都改用 `keyed Show`，传递稳定的 request value，避免 stale accessor。

## 验证步骤
1. ✅ 添加 stale pending 过滤单测。
2. ✅ 运行 app/opencode 相关测试和 typecheck。
3. ✅ 运行 app smoke 检查。

## 相关测试
- `packages/app/src/pages/session/message-timeline.test.ts`
