# Bug Fix: Session Serial Queue and Queued Message Cancel

## 问题描述

- 日期: 2026-06-28
- 严重程度: High
- 影响范围: 会话运行、排队消息、协议工具流、会话输入框

忙碌会话收到新消息时，消息应该排队等待当前 turn 结束。但当前 `SessionPrompt.prompt()` 在排队前会执行 revert cleanup 等会修改历史 message/part 的动作，可能破坏正在运行的 assistant stream，触发 SQLite 外键失败。

## 用户目标

- 一个会话同一时间只执行一个 turn。
- 忙碌时用户发送消息进入队列，不并行执行。
- 排队中的消息可以单条取消。
- 聊天框主按钮根据状态切换：
  - 空闲 + 有内容: 发送
  - 忙碌 + 有内容: 排队发送
  - 忙碌 + 空内容: 停止
  - 空闲 + 空内容: 禁用

## 根因分析

- 问题位置: `packages/opencode/src/session/prompt.ts`
- 原因: `prompt()` 在判断会话是否忙碌之前执行 `SessionRevert.cleanup(base)` 和 `repair(base)`。如果当前 processor 仍在写入 part，cleanup 删除历史消息/part 后，旧 stream 后续 `Session.updatePart()` 会引用已不存在的 message。
- 现有 delete message 路由会调用 `SessionPrompt.assertNotBusy()`，无法删除 busy 会话中的 queued user message。

## 修复方案

- 后端:
  - `prompt()` 在 busy 时只创建 queued user message，不执行 cleanup/repair/permission/model side effects。
  - 空闲 prompt 仍保留 cleanup/repair 和模型切换确认；busy prompt 延后到当前 loop 后续串行处理。
  - 新增安全取消 queued user message 的能力，只允许删除 `metadata.turn.status === "queued"` 的 user message。
  - 暴露专用路由，busy 时也可删除 queued message。
- 前端:
  - followup dock 每条排队消息增加取消按钮。
  - 本地未提交 followup 直接从本地队列移除。
  - 主输入按钮忙碌空白时执行停止；忙碌有内容时发送进入队列。

## 影响模块

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/composer/session-followup-dock.tsx`
- 相关测试

## 实际修改

- `SessionPrompt.prompt()` 新增 busy 判断；busy 时跳过 `SessionRevert.cleanup()`、`repair()`、`Session.setModel()` 和 `Session.setPermission()`。
- `Session.removeQueuedMessage()` 校验 queued user turn 后再删除 message/parts。
- `SessionPrompt.cancelQueuedMessage()` 删除 queued message 后清理对应 loop callback。
- `SessionPrompt.cancel()` 停止当前 turn 时会 reject 等待中的 queued callbacks，但不删除 queued message。
- 新增 `DELETE /session/{sessionID}/message/{messageID}/queued`，并重新生成 SDK v2。
- composer 主按钮按内容状态切换：busy 且空白时停止，busy 且有内容时继续走提交/排队。
- follow-up dock 每条排队消息增加取消按钮；本地取消只移除该条队列项。
- 更新模块文档：`docs/harness-module/protocol-runtime.md` 和 `docs/harness-module/ui-console.md`。

## 验证计划

- ✅ `packages/opencode`: `bun test test/session/prompt.test.ts test/server/session-messages.test.ts test/server/session-tree.test.ts`
- ✅ `packages/opencode`: `bun typecheck`
- ✅ `packages/app`: `bun typecheck`
- ✅ `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`
- ✅ `packages/sdk/js`: `bun typecheck`
