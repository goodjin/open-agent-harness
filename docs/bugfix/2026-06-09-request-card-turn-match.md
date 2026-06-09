# Bug Fix: Request Card Did Not Match Assistant Tool Turn

## 问题描述

- 日期: 2026-06-09
- 严重程度: High
- 影响范围: App session timeline request cards

`Protocol: SelectionBridge (local selection <-> M4.E1 EditorState) (@feature-planner)` 的最后一轮包含 `AgentProtocolOutput` confirm item，并且后端写入了 pending `session_protocol_confirmation`。但会话区域没有显示确认框。

## 根因分析

- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 原因: `MessageTimeline` 按 user message 渲染 turn，request card 挂在 user turn 下；`Question.ask` 的 `tool.messageID` 记录的是同一轮里的 assistant message id。原逻辑只允许 `input.tool.messageID === messageID`，其中 `messageID` 是 user message id，导致同一轮 assistant tool request 被过滤。

## 修复方案

- 修改文件: `packages/app/src/pages/session/message-timeline.tsx`
- 修改内容:
  - 增加同一 turn 范围匹配。
  - request 的 `tool.messageID` 只要落在当前 user message 到下一个 user message 之间，就视为属于当前 turn。
  - question 和 permission request 都使用该 turn 匹配逻辑。

## 验证步骤

1. ✅ `cd packages/app && bun typecheck`
2. ✅ `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
3. ✅ 通过 `curl http://127.0.0.1:3001/src/pages/session/message-timeline.tsx` 确认 Vite served source 已包含新的 turn 匹配逻辑。

## 相关证据

- SelectionBridge 会话的 tool part 真实 `callID` 是 `call_019ea5b171987b22a3ddf4cd`。
- 该 request 的 pending confirmation 文件存在于 `session_protocol_confirmation/.../confirm-selection-bridge-plan.json`。
- request 关联的 message 是 assistant message `msg_ea5b0abb5001vnFqhjtdluQdXp`，而 timeline request card 渲染锚点是 user message `msg_ea5ae760e0010wgc3bls2RlZf6`。
