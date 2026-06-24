# Bug Fix: Protocol Input Question Rehydrate

## 问题描述

- 日期: 2026-06-22
- 严重程度: Medium
- 影响范围: Agent Protocol v2 `input` items with option prompts

协议输出里包含 `kind: "input"` 和选项时，后端会创建 `Question.ask`，但普通 input 的 pending request 只存在内存里。页面重载、服务重启、后续 abort/revert 或 active turn 变化后，用户可能看不到选项框。

## 根因分析

- `QuestionService` 只用内存 `pending` map 保存普通问题。
- `/question` 只从 `dsl_context.protocol.confirmations` 恢复 confirm，没有恢复普通 `input`。
- 前端普通问题卡主要挂在 active timeline message 上，active message/filter 改变时可见性不稳定。

## 修复方案

- 在 protocol `input` 执行前写入 `dsl_context.protocol.inputs`。
- live 回答后标记为 `answered`；dismiss 后标记为 `rejected`。
- `/question` 恢复 pending `protocol.inputs`，并提供 reply/reject 桥接。
- composer dock 在存在 pending question 时稳定展示 `SessionQuestionDock`。

## 验证步骤

1. 运行 protocol runner input 测试，确认 `protocol.inputs` 状态从 `pending` 变为 `answered`。
2. 运行 question route 测试，确认 pending input 可恢复、reply 可继续、reject 可继续。
3. 运行 app session 相关测试，确认问题请求匹配逻辑不回退。

## 相关测试

- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/test/server/question-routes.test.ts`
- `packages/app/src/pages/session/message-timeline.test.ts`
