# Bug Fix: Protocol Execution Rejection Regeneration

## 问题描述

- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: Agent Protocol verifier dependency validation

模型输出的 protocol 包如果在执行阶段被 verifier dependency validation 拒绝，runtime 之前会直接生成 blocked result。会话区只能看到 blocked，模型没有收到“这个包为什么不接受、请重新生成合理包”的明确反馈。

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`
- 初始解析阶段的 verifier dependency issue 已有一次 retry 逻辑。
- 但 `execute()` 会先调用 `AgentVerification.apply()`，后置验证仍可能产生新的 verifier dependency issue。
- 这条后置路径直接 `rejected()` 返回 blocked run，没有进入模型重生成流程。

## 修复方案

- 增加 `repairable(run)` 判断执行前拒绝的 verifier dependency blocked run。
- `settle()` 遇到 repairable run 时调用一次 `final()`。
- `final()` 的 system prompt 注入完整拒绝原因，并要求模型只调用一次 `AgentProtocolOutput` 输出修正后的包。
- 如果修正后的包仍然非法，不再无限重试。

## 验证步骤

1. `cd packages/opencode && bun test test/session/runner.test.ts -t "rejected during execution validation|verifier packages|form input fields"`
2. `cd packages/opencode && bun typecheck`
3. `git diff --check`

## 相关测试

- `protocol runner asks model to regenerate packages rejected during execution validation`

