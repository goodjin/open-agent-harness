# Task Ledger M0 审计读取

## 用户目标

为 M0 Task Ledger 提供纯只读内部审计能力，让维护者能区分健康事实、可安全补齐的缺失派生字段和需要停止处理的持久化冲突。

## 确认范围

- 新增 `TaskLedger.audit(taskID)`，返回严格的 `ok | repairable | blocked` 结构。
- 检查 Task、current Revision、current Requirement 与完整 Requirement chain。
- 检查 Resource 与 Revision 的 task、revision、identity、lifecycle、spec/plan ref 和已存 hash 交叉一致性。
- 检查 Event 从 1 到 `last_event_seq` 连续，并验证 Event id、Command、Revision 和 Resource refs。
- 检查 Command key、Task、kind、status、result_ref 与关联 Event 一致。
- issues 最多返回 50 条；evidence 只返回计数、游标和截断信息。
- 审计不写数据库，不调用 `ensure`，不读取 URI 正文，不根据正文重算 hash。

## 分类规则

- `ok`：没有发现问题。
- `repairable`：缺失且能从唯一持久事实安全派生的 current 指针、spec/plan ref，或尚未完成且没有冲突的 accepted Command。
- `blocked`：identity、完整链、Event seq、已持久化 hash/ref、跨 Task 引用、Resource lifecycle、Command/Event 绑定或当前终态事实冲突。

`blocked` 优先于 `repairable`。返回 issues 被截断时，最终状态仍基于全部已发现问题计算。

## 不在范围

- 不实现自动 repair。
- 不实现 FR-10 外部 API、恢复或人工处置接口。
- 不读取 Resource 内容，不验证 URI 可达性。
- 不实现 M1 Graph、Action、Attempt、Checkpoint 或 Projection 审计。

## 影响模块

- `packages/opencode/src/session/task-ledger.ts`
- `packages/opencode/test/session/task-ledger.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. 健康 create、revision、migration Ledger 返回 `ok`。
2. 缺失可派生字段返回 `repairable`。
3. Requirement 链、hash/ref、Resource、Event seq/ref、Command identity/result 和终态冲突分别返回 `blocked`。
4. 长历史产生的 issues 被限制为 50 条并标记截断。
5. 审计前后数据库事实完全不变。
6. 运行 Ledger、Task 回归、数据库检查和类型检查。

## 验证结果

- audit 聚焦测试：8/8 通过，22 assertions。
- 健康覆盖 native create、draft/activate、terminal finish 与 migration。
- repairable 覆盖唯一可派生的 Requirement/spec 指针和未完成 accepted Command；多 Requirement 歧义返回 blocked。
- blocked 覆盖 Requirement chain/hash/ref、Resource identity/cross-Revision/lifecycle、Event seq/cross-Task refs、Command key/state/result/Event family 及终态矛盾。
- 80 条无效 Event 历史返回 50 条 issues，`issue_count=80`、`truncated=true`。
- Ledger 与 Task 回归：156/156 通过，729 assertions。
- `bun db check` 与 `bun typecheck` 通过。
- 独立测试和独立审计保持 pending，待提交后复核。
