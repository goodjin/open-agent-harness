# Bug Fix: Verifier Dependency Uses Action IDs

## 问题描述

- 日期: 2026-06-10
- 严重程度: High
- 影响范围: Agent Protocol verifier dependency validation

协议包中多个 worker action 复用同一个 agent target 时，`sisyphus-junior-verifier` 可能被要求依赖同 target 的最后一个 worker action，而不是模型显式声明要验证的 worker action。

## 根因分析

- 问题位置: `packages/opencode/src/session/runner.ts`
- 原因: verifier dependency validation 用 `Map<executor.target, action>` 建立 worker 映射。同一个 agent target 出现多次时，后面的 action 覆盖前面的 action。
- 错误语义: 校验把 agent 模板名当成 action 级身份，导致 `depends_on` 已经指向真实 worker action 时仍被拒绝。

## 修复方案

- 删除 verifier 必须依赖 worker action 的会话级校验，只保留普通 `depends_on` id 存在性校验。
- 删除 `<worker>-verifier` 必须匹配同名 worker target 的会话级校验。
- 保留系统主动补 verifier 的 agent 级选择逻辑：当 worker 缺少校验者时，系统仍可按 agent 模板能力和命名约定创建 verifier action，并让它依赖对应 worker action id。
- 更新协议文档和 planner 规则，明确 verifier 依赖是 action-level edge。

## 验证步骤

1. ✅ `bun test test/protocol/verifier-inference.test.ts`
2. ✅ `bun test test/session/runner.test.ts -t "accepts verifier dependencies by action id"`
3. ✅ `bun test test/session/runner.test.ts -t "allows verifier packages without worker dependencies"`
4. ✅ `bun typecheck`

## 相关测试

- `packages/opencode/test/protocol/verifier-inference.test.ts`
- `packages/opencode/test/session/runner.test.ts`
