# Bug Fix: ActionResult invalid error and verifier bash access

## 问题描述

- 日期: 2026-06-11
- 严重程度: Medium
- 影响范围: delegated worker / verifier handoff

Verifier 会话调用 `ActionResult` 失败时，界面显示 `Model tried to call unavailable tool 'invalid'`。同时部分 verifier 任务要求运行 `tsc`、`git diff` 等验证命令，但 verifier 子会话只拿到 `read/glob/grep/ActionResult`，没有 bash。

## 根因分析

- 问题位置: `packages/opencode/src/session/llm.ts`
- 原因: 非 protocol runner 的 `ActionResult` 参数解析失败后进入通用 repair path，被改写成内部 `invalid` tool，最终暴露了内部工具名。
- 问题位置: `packages/opencode/src/session/runner.ts`
- 原因: 委托创建 verifier 子会话时只使用 agent/parent 权限合并结果，没有给 verifier 统一补充验证命令所需的 bash 权限。

## 修复方案

- `ActionResult` 参数解析失败时直接返回 `ActionResult input schema/parse failed`，不再暴露内部 `invalid`。
- `ActionResult` 使用单一 `result` 字符串字段承接会话交接结果，可表示最终回答、报告、验证结论、阻塞说明或下一步请求。
- Runtime 兼容旧输入中的 `summary`，将其映射到 `result`；如果旧 summary-only 调用后还有 final plain text，Runtime 将 trailing text 兼容写入 `action_result.result`。
- verifier 子会话默认追加 `bash allow`，并追加常见变更命令的 bash deny pattern 和 `edit deny` 保持只读边界。
- verifier 委托 prompt 明确 bash 只允许用于只读验证命令，禁止修改文件、安装依赖、改变 git 状态或变更外部系统。
- 更新协议文档记录 verifier bash 和 ActionResult 错误语义。

## 验证步骤

1. ✅ 添加 malformed `ActionResult` 回归测试，确认错误不包含 unavailable `invalid`。
2. ✅ 添加 verifier 子会话权限回归测试，确认默认包含 `bash allow`、变更命令 deny 和 `edit deny`。
3. ✅ 运行相关测试和 typecheck。

## 相关测试

- `packages/opencode/test/session/llm.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/test/session/delegation.test.ts`

## 验证结果

- `bun test test/session/llm.test.ts -t "reports malformed ActionResult input without exposing invalid tool"` ✅
- `bun test test/session/action-result.test.ts test/session/delegation.test.ts` ✅
- `bun test test/session/runner.test.ts -t "protocol runner allows verifier packages without worker dependencies"` ✅
- `bun test test/session/delegation.test.ts` ✅
- `bun typecheck` ✅
- `bun test test/session/llm.test.ts` ⚠️ 仍有既有用例 `protocol runner repairs direct native tool calls into AgentProtocolOutput` 超时，和本次 `ActionResult` / verifier bash 路径无关。
