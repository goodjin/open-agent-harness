# Bug Fix: Protocol Input Received Summary

## 问题描述

- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: protocol runner 的用户输入类交互摘要

用户在 `New session - 2026-06-10T04:33:04.218Z` 中选择完成度检查深度后，会话区显示：

```text
Protocol blocked: 选择完成度检查的深度与推进范围
choose_completion_audit_depth: blocked
```

但随后模型又继续输出 answer，看起来与 blocked 状态矛盾。

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`
- `inquire()` 收到用户选择后会返回 `metadata.blocked = true` 和 `reason = "input_received"`。
- 这不是终止性 blocked，而是 runtime 用来停止当前 protocol 包、把用户输入交回模型继续决策的控制信号。
- `revision(run)` 会识别这类 input/confirm blocked 并继续调用 `final()`，所以后续出现 answer 是符合执行流程的。
- `summarize()` 没有区分控制性中断和真实 blocked，统一展示成 `Protocol blocked`，导致会话区误导。

## 修复方案

- 增加 `receipt()` 判断 blocked run 是否来自 human `input` / `confirm`。
- `summarize()` 对 input 展示 `Protocol input received`，对 confirm 展示 `Protocol confirmation resolved`。
- `protocol_summary` 的 `metadata.action` 对 input/confirm 中断分别写为 `input_received` / `confirmation_resolved`，避免 UI 继续按 blocked 摘要处理。
- 保留底层 run status 为 `blocked`，避免破坏 `revision(run)` 的续跑控制逻辑。
- 扩展 form input 测试，覆盖用户 reply 后摘要展示和后续 answer 输出。

## 验证步骤

1. 运行 `cd packages/opencode && bun test test/session/runner.test.ts -t "form input fields"`。
2. 运行 `cd packages/opencode && bun typecheck`。
3. 运行 `git diff --check`。

## 相关测试

- `packages/opencode/test/session/runner.test.ts`
