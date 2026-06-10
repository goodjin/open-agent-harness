# Bug Fix: Protocol runtime catalog cache consistency

## 问题描述
- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: Agent Protocol runner prompt cache and runtime tool execution

Protocol runner 的 prompt cache 只缓存了 prompt 文本。后续轮次如果 agent 或 runtime catalog 变化，模型仍可能看到旧 prompt 中的工具列表，但 runner 会用当前 `runtime.catalog` 校验执行，导致提示和执行不一致。

## 根因分析
- 问题位置: `packages/opencode/src/session/prompt.ts`
- 原因: `stable()` 只判断缓存中是否存在 `protocol.prompt`，没有校验当前 agent 和 catalog 是否仍匹配。
- 影响: prompt cache 有效，但可能过度复用，尤其在切换 agent、权限变化、用户工具开关变化、MCP 工具变化时，会让模型看到 stale tool catalog。

## 修复方案
- 缓存 `agent`、可读 `catalog` id 列表和完整 `signature`。
- 只有当前 agent 与完整 catalog signature 都匹配时才复用缓存 prompt。
- agent 或 catalog 变化时使用当前 runtime prompt，并写回新的缓存。
- legacy `dsl_context.protocol.tools.prompt` 迁移时，只有 catalog id 列表匹配当前 catalog 才复用 legacy prompt。

## 验证步骤
1. ✅ `cd packages/opencode && bun test test/session/prompt-runner.test.ts -t "protocol prompt"`
2. ✅ `cd packages/opencode && bun test test/session/llm.test.ts -t protocol`
3. ✅ `cd packages/opencode && bun typecheck`

## 相关测试
- `packages/opencode/test/session/prompt-runner.test.ts`
- `packages/opencode/test/session/llm.test.ts`
