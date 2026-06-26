# Bug Fix: Protocol input resume context and resumed child assignment

## 问题描述

- 日期: 2026-06-26
- 严重程度: High
- 影响范围: protocol planner input continuation, resumed dependent child sessions

两个相关问题会让 planner 链路偏离用户意图:

1. 用户回答 `input` 后, final pass 只在 runtime transcript 里弱提示用户选择, 模型可能继续沿用旧上下文里的默认值或假设。
2. dependent agent 通过 delegation resume 启动时只写 delegation context, 没写 active assignment, 子会话再派发 agent work 时会触发 assignment gate。

## 根因分析

- `packages/opencode/src/session/runner.ts` 的 `final()` 只写通用提示, 没把已解析 input 以结构化、靠前的形式加入系统提示。
- `packages/opencode/src/session/runner.ts` 的 input 输出有用户选择, 但摘要像日志, 不适合作为强输入事实。
- `packages/opencode/src/session/delegation.ts` 的 resumed launch 路径调用 `assign(...)`, 但缺少与 runner 直接 launch 路径相同的 `SessionAssignment.delegate(...)`。

## 修复方案

- 在 final pass 系统提示中加入 `Resolved user input from previous runtime interaction` block。
- 该 block 只忠实转述 action id、question、mode、选项 id/label/description、custom/details, 不推断业务含义。
- 在 resumed dependent child launch 后写入 `SessionAssignment.delegate(...)`。
- 增加回归测试覆盖 final prompt 中的 resolved input block, 以及 resumed child 有 active delegation assignment。

## 验证步骤

1. 运行 `packages/opencode` 内的 focused runner/delegation tests。
2. 运行 `bun typecheck` from `packages/opencode`。

## 相关测试

- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/test/session/delegation.test.ts`
