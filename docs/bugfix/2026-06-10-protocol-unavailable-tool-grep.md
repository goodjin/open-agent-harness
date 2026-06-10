# Bug Fix: Protocol unavailable grep tool selection

## 问题描述
- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: Agent Protocol runner, technical-reviewer delegated sessions

`Protocol: review_apply_to_project (@technical-reviewer)` 会话中，模型声明了 `kind: "tool"`、`target: "grep"`，Runtime 返回：

`Action 'check_c5_markClean' references unavailable tool 'grep'.`

## 根因分析
- 问题位置: `packages/opencode/config/protocol/agent-protocol-v2.md`
- 原因: Agent Protocol 基础文档的输出示例写死了 `target: "grep"`。当当前 runtime catalog 没有列出 grep 时，模型仍可能被固定示例诱导选择 grep。
- 问题位置: `packages/opencode/src/session/runtime-tools.ts`
- 原因: `allowed_tools` 决定 agent 直接运行时可用工具；protocol `kind: "tool"` 只能使用当前 `runtimeTools.catalog` 中列出的工具。default protocol runner 会隐藏 repo read/search tools，只暴露 session 管理类工具；其它 protocol runner 才会按自身权限展示 read/grep/glob 等工具。
- 问题位置: `packages/opencode/src/session/runner.ts`
- 原因: unavailable tool 错误没有列出当前可用 catalog，导致无法判断是权限过滤、catalog 隐藏，还是模型选错工具。

## 修复方案
- `agent-protocol-v2.md`: 将固定 `grep` 示例改成 `<listed-tool-id>` 占位，避免误导模型。
- `runner.ts`: unavailable tool 报错增加当前可用 protocol tools，并提示应只使用 listed tools 或委托给合适 agent。
- `llm.test.ts`: 添加测试确保基础 protocol prompt 不再硬编码 `target: "grep"`。

## 验证步骤
1. ✅ `cd packages/opencode && bun test test/session/llm.test.ts -t protocol`
2. ✅ `cd packages/opencode && bun typecheck`

## 相关测试
- `packages/opencode/test/session/llm.test.ts`
