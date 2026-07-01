# Bug Fix: Protocol plain text result handoff

## 问题描述

- 日期: 2026-07-01
- 严重程度: Medium
- 影响范围: protocol runner final/follow-up, delegated protocol child result handoff, session timeline output

协议会话有时没有调用 native `AgentProtocolOutput` 工具，而是在普通文本中输出 Markdown 或 JSON fenced block。界面上可能已显示前一轮 `AgentProtocolOutput` 调用，但后续 final/follow-up 阶段没有真实 tool part，导致用户看到文本输出却没有新的协议结果执行。

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`
- `protocol()` / `final()` 已有一次 retry 机制，但 retry 后仍无 native tool call 时，会走 plain fallback。
- plain fallback 只记录 `protocol.final.plain` / `protocol.final.plain_json` 等日志，并以普通完成结束。
- 对 delegated protocol child 来说，这类文本结果应作为一个明确任务结果交付给父会话；对独立会话来说，文本应直接作为最终展示内容保留。

## 修复方案

- 增加 `plain_text_result` 任务结果投影:
  - 独立会话: 保留未忽略文本，直接给用户展示。
  - 子会话: 将文本作为 delegated result 交付给父会话。
- 在 delegation metadata 中记录 `result.type = "plain_text_result"` 和 `source = "protocol_plain_text"`。
- 在日志中区分 plain text result，避免把它误判为 native DSL 成功。
- 添加回归测试覆盖 delegated protocol child 输出纯文本时，父会话能收到结果。

## 影响文件

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/result.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

从 `packages/opencode` 运行:

- `bun test test/session/runner.test.ts -t "plain text result"`
- `bun typecheck`
