# Bug Fix: Protocol tool prompt agent dispatch

## 问题描述

- 日期: 2026-07-02
- 严重程度: High
- 影响范围: Agent Protocol v2 parsing, delegated child session dispatch

会话 `ses_0deb8a80dffe3fMfcAcmV2PpYf` 中，界面显示模型调用了 `AgentProtocolOutput`，内容意图是分派 `general-investigator` 子任务；但运行时没有创建子会话。

## 根因分析

- 问题位置: `packages/opencode/src/protocol/schema.ts`
- native `AgentProtocolOutput` 工具调用是存在的。
- 模型输出的 v2 item 形态为 `kind: "tool", target: "general-investigator", prompt: "..."`
- 运行时将 `kind: "tool"` 归一成 runtime tool action，并在 runtime tool catalog 中查找 `general-investigator`。
- 当前 runtime tools 只有 `delegation_status`, `session_tree`, `session_result`, `session_continue`，所以 action 被判为 unavailable tool。
- `V2Tool` schema 未声明 `prompt`，解析时该字段被丢弃，executor 层已经无法恢复 agent brief。

## 修复方案

- `V2Tool` 接受 `prompt` / `capabilities` / `context_refs` / `verification` 字段。
- 当 v2 `tool` item 带 `prompt` 时，归一化为 `executor.type = "agent"`，并保留 prompt、capabilities、context refs、verification。
- 不改变普通 `tool + args` 的 runtime tool 行为。

## 验证步骤

- `bun test test/protocol/schema.test.ts -t "tool items with prompts"`
- `bun typecheck`

## 相关测试

- `packages/opencode/test/protocol/schema.test.ts`
