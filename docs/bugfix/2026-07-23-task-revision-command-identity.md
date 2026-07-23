# Task Revision Command 身份修复

## 问题描述

- 日期：2026-07-23
- 严重程度：Critical
- 影响范围：开启 Task Ledger 后，不带 message 或 assignment 来源的 Revision draft

T-07 的 draft fallback Command key 仅包含 Task、当前 Revision 和正文摘要。同一当前 Revision 下，正文相同但标题、原因或 workflow 不同的合法 draft 会复用同一 Command，并被错误判定为 identity drift。

## 根因分析

- 问题位置：`packages/opencode/src/session/task.ts` 的 `drafted()` fallback key。
- Command key 没有覆盖会写入 Revision 或 Requirement 的完整稳定输入。
- 简单字符串拼接无法安全表达结构化 workflow，也存在分隔符碰撞风险。

## 修复方案

1. 为 fallback draft 构造规范化命令身份，覆盖 `previous_id`、`title`、`body`、规范化后的 `reason`、`workflow` 和 source identity。
2. 使用按对象键排序的 canonical JSON 进行 SHA-256 摘要。
3. 身份中不加入随机 Revision ID、分配的 version 或执行时间。
4. 保留 message 和 assignment 已有稳定 key，不扩大 T-07 范围。

## 验证计划

1. 同一当前 Revision、同正文但标题不同可分别创建 draft。
2. 同一当前 Revision、同正文但 reason 不同可分别创建 draft。
3. 完全相同输入精确重放，不新增 Requirement、Revision、Resource、Event 或 Command。
4. workflow 对象键顺序及 optional 空值的等价表示得到相同摘要。
5. 运行 Ledger、Task、Handoff 回归、数据库检查和类型检查。

## 影响文件

- `packages/opencode/src/session/task.ts`
- `packages/opencode/test/session/task.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证结果

- fallback identity 聚焦测试：1/1 通过。
- Ledger、Task、Handoff 组合回归：144/144 通过，661 次断言。
- `bun db check`：通过。
- `bun typecheck`：通过。
