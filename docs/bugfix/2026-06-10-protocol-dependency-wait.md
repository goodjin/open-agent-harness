# Bug Fix: Protocol Dependencies Wait For Delegated Child Results

## 问题描述

- 日期: 2026-06-10
- 严重程度: High
- 影响范围: Agent Protocol action scheduling

协议包中 action 已经声明 `depends_on`，但前置 action 是 agent delegation 时，Runtime 只创建了 child session 就把该 action 记为 completed，导致依赖它的 verifier 或测试 action 在 child session 完成前被启动。

示例：`verify_typecheck_and_tests` 声明依赖 `test_showPrivacyStatement`，但 `test_showPrivacyStatement` 只是被委托到子会话，尚未返回结果时，verifier 已被调度。

## 根因分析

- 问题位置: `packages/opencode/src/protocol/executor.ts`
- 原因 1: executor 按数组顺序执行 action，没有按 `depends_on` 做 DAG 调度。
- 原因 2: agent delegation 返回 `metadata.delegated=true` 时被当成 completed。实际上这只表示 child session 已创建，不表示 action 结果已经可用。

## 修复方案

- executor 按当前包内 `depends_on` 做拓扑调度；依赖当前包 action 的节点只有在前置节点达到终态后才会执行。
- 历史 child-session action id 仍由 runner 的 dependency validation 校验，executor 中不重复查存储。
- `metadata.delegated=true` 的 action 在当前 run 中投影为 blocked/waiting，并保留 child session id；依赖它的下游 action 不会启动。
- 当没有可运行 action 且存在未满足依赖时，executor 记录等待中的 action，而不是执行它。
- 更新 Action Executor 契约文档，明确 delegation assignment 不等于 action completion。

## 验证步骤

1. ✅ `bun test test/protocol/executor.test.ts`
2. ✅ `bun test test/session/runner.test.ts -t "accepts verifier dependencies by action id"`
3. ✅ `bun test test/session/runner.test.ts -t "allows verifier packages without worker dependencies"`

## 相关测试

- `packages/opencode/test/protocol/executor.test.ts`
- `packages/opencode/test/session/runner.test.ts`
