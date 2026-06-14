# Bug Fix: Terminal Turn Repeat Loop

## 问题描述

- 日期: 2026-06-13
- 严重程度: High
- 影响范围: delegated child sessions and ordinary prompt loop turns

`Protocol: 根 tsc 170 错误分类与修复策略 (@general-investigator)` 在 `ActionResult` 成功后仍持续对同一个 user message 发起 LLM 请求。请求体不是完全相同，后续请求会追加上一轮 assistant 文本，但控制目标始终是同一个 unfinished user turn。

## 根因分析

- 问题位置: `packages/opencode/src/session/processor.ts`
- 问题位置: `packages/opencode/src/session/prompt.ts`

`SessionProcessor.process()` 对普通 terminal text response 没有返回 terminal 状态。assistant `finish=stop`、无 error、无 ActionResult/tool action 时，函数在 memory capture 后返回 `continue`。外层 `SessionPrompt.loop()` 只有在 terminal result 上才会调用 `SessionTurn.finish()`，因此当前 user turn 保持 `running`，下一轮又被 `turn()` 选中。

## 修复方案

- `SessionProcessor.process()` 在 assistant terminal finish 且无 pending action 时返回 `stop`。
- `SessionPrompt.loop()` 增加防御: 即使 processor 返回 `continue`，只要 assistant 已 terminal 且无 error，也先 `SessionTurn.finish()` 当前 user turn。
- 增加回归测试，模拟 terminal assistant response 后 processor 错误返回 `continue`，断言同一 turn 不会再次调用 processor。

## 验证步骤

1. ✅ 新测试先失败: `calls` expected 1, received 2。
2. ✅ 应用修复。
3. ✅ `bun test test/session/prompt-runner.test.ts -t "session loop closes terminal text response when processor returns continue"`。
4. ✅ `bun test test/session/prompt-runner.test.ts`。
5. ✅ `bun test test/session/prompt.test.ts`。

## 相关测试

- `packages/opencode/test/session/prompt-runner.test.ts`
- `packages/opencode/test/session/prompt.test.ts`

## 设计建议

Provider retry and prompt-loop continuation should remain separate. A complete assistant response is a request-level success; only explicit pending work should drive another model request for the same user turn.
