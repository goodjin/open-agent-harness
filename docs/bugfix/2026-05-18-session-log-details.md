# Bug Fix: Session Log Details

## 问题描述

- 日期: 2026-05-18
- 严重程度: Medium
- 影响范围: WebUI 会话日志查看

会话日志页只能看到 LLM/tool/reasoning 的事件摘要，看不到实际 prompt、思考文本和输出内容；同时日志动态追加后，已经展开的详情会自动收起。

## 根因分析

- 后端只在 `llm.start` 中记录消息数量和工具数量，没有记录请求 prompt/message 内容。
- `reasoning.end` 和 `text.end` 只记录字符数，没有记录文本内容。
- 前端使用原生 `<details>` 的内部状态；日志列表 reconcile 后 DOM 状态会丢失，导致展开状态被重置。

## 修复方案

- `packages/opencode/src/session/processor.ts`:
  - `llm.start` 记录 `request.system`、`request.messages`、`request.user`、`request.toolChoice`、`request.tools`。
  - `reasoning.end` 记录完整 reasoning 文本。
  - `text.end` 记录完整输出文本。
- `packages/app/src/pages/session/session-log-timeline.tsx`:
  - 用 `store.open` 按日志 id 控制详情展开状态，动态日志更新时保持原状态。

## 验证步骤

1. 运行 session processor 测试，确认 prompt/reasoning/text 写入日志。
2. 运行 session log timeline 测试，确认 LLM 日志摘要正常。
3. 运行 opencode/app typecheck。
