# Bug Fix: Session Confirm Dock Scope

## 问题描述

- 日期: 2026-06-09
- 严重程度: High
- 影响范围: `packages/app` 会话确认框、`packages/opencode` question 路由

`Protocol: m4_e5_v3_app_shell_e2e` 存在 pending confirm，但打开会话后没有稳定出现确认框。确认请求还可能跨项目出现在其它项目页面里，并且同一个确认有时同时出现在会话 timeline 内部和 composer/弹层式确认区域。confirm-only 请求的主按钮文案显示为 `Submit`，语义不对。

## 根因分析

- `MessageTimeline` 原先只渲染 pending question，请求被 reply/reject 事件移除后没有可展开的只读占位。
- `SessionComposerRegion` 也渲染了当前会话树的 question dock，和 timeline 内部请求卡形成重复确认入口。
- `/question` 恢复 protocol confirm 时扫描当前进程可见的所有 session，没有显式限制到当前 directory。
- `SessionQuestionDock` 对所有 question 都用通用 `Submit` 主按钮，没有识别 confirm-only 请求，也没有提交明确 `response: "confirm" | "cancel"`。

## 修复方案

- 移除 `SessionComposerRegion` 中的 question dock，确认交互只在会话 timeline 内显示。
- `MessageTimeline` 从 `dsl_context.protocol.confirmations` 渲染 confirmation card；pending 时嵌入可操作 dock，confirmed/cancelled 后折叠为只读占位，可展开查看 plan。
- `SessionQuestionDock` 识别 confirm-only 请求，隐藏选项列表，主按钮直接显示 `Confirm`，拒绝按钮显示 `Cancel`。
- synthetic protocol confirm 的 `/reply` 按明确 `response` 标记 `confirmed` 或 `cancelled`，避免本地化确认文案被误判。
- `/question` 用当前 directory 的 `Session.list()` 过滤 live 和 restored question，避免跨项目弹提示。

## 验证步骤

- `cd packages/opencode && bun test test/server/question-routes.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/app && bun test src/pages/session/composer/session-question-dock.test.ts`
- `cd packages/app && bun typecheck`
- `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
- 浏览器打开 `Protocol: m4_e5_v3_app_shell_e2e`，确认只在会话 timeline 内出现，按钮为 `Cancel` / `Confirm`；提交后卡片折叠为只读占位，可展开查看 plan。
