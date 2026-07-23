# Task Result Canonical Locator 修复

## 问题描述

- 日期：2026-07-23
- 严重程度：Critical
- 影响范围：Task Ledger 的 `result.recorded` 结果引用

T-08 首版按 `session_id + run_id + carrier` 查询最新 `session_result`。该条件没有绑定 parent Session、child Session、Action 和当前 Revision，可能引用同一 Run 的另一 Action、旧 Revision 或其他 Task 的结果。

## 根因分析

- `session_result` 的 canonical identity 是 parent、child、Run、Action 和 carrier 的组合事实。
- delegated Task 的 locator 保存在 `session_task.source_ref`。
- 非 delegated Task 只能从当前 Revision workflow 与 canonical delegation Assignment 证明 child locator。
- `created_at` 只表示时间，不能作为结果归属裁决。

## 修复方案

1. delegated Task 从 `source_ref` 提取 parent、child、Run、Action，并绑定请求 carrier。
2. 非 delegated Task 从当前 Revision workflow 的 Action 和对应 delegation Assignment 构造候选 locator。
3. 精确匹配零条时使用稳定 Task Revision result URI；一条时使用 `session-result://<id>`；多条 canonical 候选时冲突。
4. `TaskLedger.result` 接收 locator，重新加载 `session_result`、Task、当前 Revision 和 Assignment 做二次校验。
5. 禁止使用 `created_at` 或任意“最新一条”规则选择结果。

## 验证计划

1. 跨 Action、旧 Revision 和跨 Task 结果不能干扰当前引用。
2. 同毫秒多个候选不按时间猜测，返回冲突。
3. 覆盖零条、一条、多条精确候选。
4. 伪造 `session-result://` 引用被 Ledger 拒绝。
5. 数据库重开后同一 locator 保持稳定。
6. 运行 Ledger、Task、ActionResult、Handoff 回归、数据库检查和类型检查。

## 影响文件

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-ledger.ts`
- `packages/opencode/test/session/task.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证结果

- canonical locator 定向回归通过，覆盖跨 Action 干扰、旧 Revision、零条/一条/多条候选、伪造引用与数据库重开后的稳定引用。
- Ledger、Task、ActionResult、Handoff 全量指定回归通过：160 个测试通过，0 个失败，769 次断言。
- `bun db check` 通过。
- `bun typecheck` 通过。
