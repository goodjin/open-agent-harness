# Bug Fix: Composer Hidden While Request Card Is Visible

## 问题描述

- 日期: 2026-06-09
- 严重程度: Medium
- 影响范围: App session composer, question/permission request UI

在 `Protocol: Implement ComponentNode.tsx (@frontend)` 这类会话里，模型最后发起 `question` 请求后，会话处于 `waiting_user`。请求卡展开后底部普通输入框消失，用户无法继续直接输入。

## 根因分析

- 问题位置: `packages/app/src/pages/session/composer/session-composer-region.tsx`
- 原因: `SessionComposerRegion` 用 `props.state.blocked()` 包住了整个 composer 内容。`blocked()` 在存在 question 或 permission request 时为 true，于是 `PromptInput` 也被整体移除。
- 代码流程:
  1. `createSessionComposerState` 从当前会话或子会话找到 pending question/permission。
  2. `blocked()` 变为 true。
  3. `SessionComposerRegion` 的外层 `<Show when={!props.state.blocked()}>` 关闭。
  4. 底部输入框和 followup dock 一起消失。

## 修复方案

- 修改文件: `packages/app/src/pages/session/composer/session-composer-region.tsx`
- 修改内容: 移除隐藏整个 composer 的 `blocked()` 外层条件，让 request card 显示时 `PromptInput` 仍然渲染。
- `blocked()` 仍保留在 `session.tsx` 的 followup queue gating 中，避免 pending request 时自动发送 queued followup。

## 测试更新

- 修改文件: `packages/app/e2e/session/session-composer-dock.spec.ts`
- 修改内容: question/permission request 出现时，断言 request dock 可见且 prompt input 也可见。
- 焦点用例改为验证 request card 显示时 prompt 不会自动抢焦点，而不是验证 prompt 不存在。

## 验证步骤

1. ✅ `cd packages/app && bun typecheck`
2. ✅ `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
3. ⚠️ `cd packages/app && bun test:e2e:local -- session/session-composer-dock.spec.ts`
   - 结果: 2 passed, 9 failed
   - 阻塞原因:
     - question seed 依赖测试环境模型 `deepseek/deepseek-v4-flash`，当前配置缺失导致 `ProviderModelNotFoundError`，进而 seed 超时。
     - permission mock 用例没有真实 message turn；request card 已移动到会话消息区域后，这类旧 mock 不再能渲染 permission dock。

## 设计建议

- 后续应把 request-card e2e fixture 改成创建真实 user/assistant/tool message turn，而不是只 mock request list。
- `followup` 文案表示的是当前会话待发送输入队列，不是子会话返回结果；UI 文案应避免使用容易和子会话回复混淆的“回复内容”。
