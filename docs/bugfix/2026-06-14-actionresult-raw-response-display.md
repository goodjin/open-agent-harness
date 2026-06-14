# Bug Fix: ActionResult Raw Response Display

## 问题描述

- 日期: 2026-06-14
- 严重程度: Medium
- 影响范围: delegated child session 中 `ActionResult` schema/parse 失败的错误展示与日志排查。

工具错误卡片只展示系统生成的 schema/parse 错误文本。即使错误文本里拼了 `Raw tool input: {}`，前端仍然看不到这次 provider 返回流的原始响应事件。

## 根因分析

- 问题位置: `packages/opencode/src/session/processor.ts`
- 原因: `llm.start` 只保存了请求 payload，流式响应侧没有保存 bounded response payload；工具错误 part metadata 也没有包含 response transcript 或 payload id。
- 前端问题位置: `packages/ui/src/components/tool-error-card.tsx`
- 原因: 工具错误卡片只接收 `error` 字符串，没有展示工具 part metadata 中的原始输入、响应 transcript 或 payload id。

## 修复方案

- 在 session processor 中为每次 LLM 调用生成独立 `responsePayload`。
- 从 `fullStream` 捕获 response event transcript，消息卡片只展示截断预览，完整 events 写入 session-log-payload。
- 在 `tool-error` 和 `tool.action_result` 失败日志里写入 `rawResponse`、`rawResponseBytes`、`rawResponseTruncated`、`responsePayload`。
- 在工具错误 part metadata 中保存同样的响应证据，供消息时间线直接展示。
- 在日志详情页为 `llm.start` 增加 Response payload loader。
- 在工具错误卡片中展示 `Raw tool input`、`Raw response`、`Response payload`。
- 当 `Raw response` 过大时，展示预览字符数、总字符数和剩余字符数，并提供 Export full response 按钮导出完整 payload。

## 验证步骤

1. ✅ `packages/opencode`: `bun typecheck`
2. ✅ `packages/app`: `bun typecheck`
3. ✅ `packages/app`: `bun test src/pages/session/session-log-timeline.test.ts`
4. ✅ `packages/opencode`: `bun test test/session/prompt-runner.test.ts`
5. ✅ `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`

## 相关测试

- `packages/app/src/pages/session/session-log-timeline.test.ts`
- `packages/opencode/test/session/prompt-runner.test.ts`
