# Bug Fix: Session Model Change Confirmation

## 问题描述

- 日期: 2026-06-14
- 严重程度: High
- 影响范围: 会话继续提交、终端上下文提交、slash command、session tree model 更新

前端提交请求会携带当前选择的 model。旧逻辑在请求 model 与会话绑定 model 不一致时直接覆盖 `session.model`，用户没有机会确认，容易让会话在继续输入后切到错误模型。

## 根因分析

- 问题位置:
  - `packages/opencode/src/session/prompt.ts`
  - `packages/opencode/src/session/index.ts`
  - `packages/app/src/components/prompt-input/submit.ts`
- 原因: `SessionPrompt.prompt()` 在检测到请求 model 与 `session.model` 不同时直接调用 `Session.setModel()`，而 `Session.setModel()` 本身没有冲突确认门。
- 代码流程: 前端提交 model -> 后端 prompt 写入 `session.model` -> 用户消息创建 -> 后续 loop 使用新的 session model。

## 修复方案

- `Session.setModel()` 增加 `confirm` 参数。
- 已绑定 model 被不同 model 覆盖时，没有 `confirm: true` 直接返回 `409 Conflict`。
- prompt、command、shell、session tree model 更新统一走该确认门。
- 前端 submit 捕获 409，确认则带 `confirm: true` 重试，取消则切回绑定 model 后重试。

## 验证步骤

1. 运行后端 prompt model 绑定测试。
2. 运行后端 session tree model 冲突测试。
3. 运行前端 submit model 冲突确认/取消测试。
4. 运行相关完整测试文件、类型检查和 app smoke。

## 相关测试

- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/server/session-tree.test.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
