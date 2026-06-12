# Bug Fix: Protocol Invalid Raw Output

## 问题描述

- 日期: 2026-06-11
- 严重程度: Medium
- 影响范围: protocol-runner 模型输出损坏的 `AgentProtocolOutput` tool-call 时，会话里只能看到 parser error 的截断 `Text:` 片段，日志里也没有 provider 流出的原始 arguments。

## 根因分析

- 问题位置: `packages/opencode/src/session/llm.ts`, `packages/opencode/src/session/processor.ts`
- malformed native tool-call 会被 LLM 层转成内部 `invalid` tool result。
- `invalid` result 只拼接 parser error，没有把 parser error 中的 raw `Text:` 片段单独写入 output 或 metadata。
- processor 对 `tool-input-delta` 没有记录，`tool.start` 只能看到修复后的 `invalid` input，无法和 provider 原始输出对照。

## 修复方案

- 从 parser error 中提取 `Text:` 到 `Error message:` 之前的原始片段。
- 在 invalid tool result output 中增加 `Raw protocol output:` section。
- 将同一 raw 片段写入 metadata，供 UI detail 和复制路径使用。
- 累积 pending tool part 的 `tool-input-delta`，在 `tool.input.end` 和 `tool.start` 日志写入 64 KiB 上限的 `raw`、`rawBytes`、`truncated`。

## 验证步骤

1. 添加回归测试覆盖 malformed `AgentProtocolOutput` arguments。
2. 添加 processor 回归测试覆盖原始流式 tool input 日志。
3. 运行定向 LLM stream 和 session processor 测试。
4. 运行 package typecheck。

## 相关测试

- `bun test test/session/llm.test.ts -t "protocol invalid output shows raw malformed AgentProtocolOutput"`
- `bun test test/session/llm.test.ts -t "protocol runner repairs direct native tool calls into AgentProtocolOutput"`
- `bun test test/session/session.test.ts -t "records raw streamed tool input before invalid repair"`
- `bun typecheck`
