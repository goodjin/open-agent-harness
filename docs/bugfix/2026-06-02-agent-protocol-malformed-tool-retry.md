# Bug Fix: Malformed AgentProtocolOutput Tool Retry

## 问题描述

- 日期: 2026-06-02
- 严重程度: High
- 影响范围: protocol-runner agent 继续执行任务时，模型生成损坏的 `AgentProtocolOutput` tool-call 后，runtime 可能停止而不是重试。

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`
- 模型先输出普通进度文本，然后提交了一个格式损坏的 `AgentProtocolOutput` tool-call。
- LLM 层把损坏 tool-call 转成 `invalid` tool result，metadata 标记为 protocol violation。
- runner 看到普通文本后，把该轮当作已有 protocol work 后的 plain final answer 接受，导致没有进入 malformed retry。

## 修复方案

- 新增 `invalidOutput()` 检测 protocol-runner 的 `invalid` tool result。
- 当检测到损坏的 `AgentProtocolOutput` 时：
  - 不允许 plain answer 快速返回。
  - 记录 `protocol.retry`，reason 为 `invalid_protocol_tool_call`。
  - 重新提交上下文给模型，并附加说明：上一轮 `AgentProtocolOutput` JSON malformed，模型没有严格遵守协议，需要重新调用一次合法 tool-call。

## 验证步骤

1. 添加回归测试覆盖“普通进度文本 + malformed AgentProtocolOutput invalid tool result”。
2. 运行定向测试确认会触发重试而不是停止。
3. 运行 package typecheck。

## 相关测试

- `bun test test/session/runner.test.ts -t "protocol runner retries malformed native AgentProtocolOutput after plain progress text"`
- `bun typecheck`
