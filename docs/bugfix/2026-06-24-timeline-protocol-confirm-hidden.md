# Bug Fix: Timeline Protocol Confirm Hidden

## 问题描述

- 日期: 2026-06-24
- 严重程度: High
- 影响范围: session timeline 中的 protocol confirmation / delegation rows

Protocol session 已经进入 `waiting_user`，但 timeline 没有显示确认卡，导致用户无法在设计的 timeline 表面确认或取消。

## 根因分析

- 问题位置: `packages/app/src/pages/session/session-delegations.ts`
- 原因: timeline 通过 `turn(messages, userMessageID, protocolMessageID)` 判断确认记录属于哪个 user turn。旧逻辑按消息数组里的连续 user/assistant 区间判断，迟到的 assistant message 如果排在后续 user message 后面，就不会匹配原 user turn。
- 代码流程: `message-timeline.tsx` 读取 `dsl_context.protocol.confirmations` 后调用 `confirmations()`；`confirmations()` 再调用共享的 `turn()`。`turn()` 返回 false 时确认记录被过滤，timeline 不渲染确认卡。

## 修复方案

- 修改文件:
  - `packages/app/src/pages/session/session-delegations.ts`
  - `packages/app/src/pages/session/session-delegations.test.ts`
  - `docs/harness-module/ui-console.md`
- 修改内容:
  - `turn()` 优先使用 `assistant.parentID === user.id` 判断 turn 归属。
  - 有明确 `parentID` 的 assistant message 不再回落到连续区间匹配，避免误归属到后续 user turn。
  - 补充迟到 assistant message 的回归测试。

## 验证步骤

1. ✅ 运行 focused test 复现并验证 late assistant parent 匹配。
2. 未通过: 运行 app typecheck；失败在已有 `prompt-input` / `submit.test` 类型错误，未指向本次 timeline 文件。
3. ✅ 运行 app smoke。

## 相关测试

- `packages/app/src/pages/session/session-delegations.test.ts`
