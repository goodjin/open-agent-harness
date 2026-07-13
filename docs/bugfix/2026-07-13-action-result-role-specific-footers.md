# Bug Fix: ActionResult 按 Agent 元数据加载角色协议

## 问题描述

- 日期：2026-07-13
- 严重程度：High
- 影响范围：协议委托的 worker、helper 与 verifier 结果提交
- 现象：`final_qa_check (@verifier)` 在无法推导 `target_action_id` 时收到 worker 结果示例，模型据此返回 worker 字段，最终缺少 verifier 必填字段而解析失败。

## 根因分析

- `action-protocol.md` 同时描述 worker 与 verifier 两套结果协议。
- `RequestFooter.example()` 仅根据是否存在 target 选择示例；target 缺失时，即使 agent 类型是 verifier，也会生成 worker 示例。
- agent 元数据已经声明 `kind` 和 `request_footer`，但 action agent 共用同一份混合 footer，角色边界没有落实到配置层。

## 修复方案

1. 将共享 footer 拆为 `action-worker.md` 与 `action-verifier.md`。
2. worker/helper agent 的元数据显式配置 `action-worker.md`；verifier agent显式配置 `action-verifier.md`。
3. footer 示例生成显式接收 verifier 上下文；verifier 缺少 target 时使用 `worker_action_id` 占位，不降级为 worker 示例。
4. 保留原生 ActionResult schema 作为最终输入校验边界。
5. 重新生成 `builtin.generated.ts`，确保打包内置 agent 与源配置一致。

## 影响模块

- `packages/opencode/config/request-footers/`
- `packages/opencode/config/agents/*/meta.json`
- `packages/opencode/src/session/request-footer.ts`
- `packages/opencode/src/agent/builtin.generated.ts`
- request footer 与 ActionResult 定向测试

## 验证计划

1. verifier 有 target 时生成 verifier 协议示例。
2. verifier 无 target 时仍生成 verifier 协议示例，并包含占位 `target_action_id`。
3. worker/helper 继续生成 worker 协议示例。
4. 所有 action agent 的元数据不再引用混合 `action-protocol.md`。
5. 从 `packages/opencode` 运行相关 Bun 测试与 `bun typecheck`。

## 文档影响

已同步 `docs/harness-module/protocol-runtime.md` 中的动态 agent footer 与 ActionResult 角色边界。
