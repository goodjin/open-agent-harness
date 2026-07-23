# 集成测试计划：M0 Task Ledger

- 模块：MOD-05
- 优先级：P0
- 依赖：T-01—T-10

## 1. 测试目标

证明 M0 新事实与现有 Task Runtime 同步提交，同时不改变当前执行、恢复、历史和 legacy admission 语义。

## 2. 场景

| 编号 | 场景 | 预期 |
|---|---|---|
| INT-01 | canonical create 后进程重新打开数据库 | Task、Requirement、Resource、Command、Event 均可读取 |
| INT-02 | 同一 create/finish 重放 | 不产生重复 Requirement、Resource、Command 或 terminal Event |
| INT-03 | draft 激活中途事务失败 | Revision 与 Ledger 一起回滚，不出现半套事实 |
| INT-04 | 现有 Task 首次进入写边界 | 生成 migration baseline，不猜测用户确认或历史事件 |
| INT-05 | 单 Run legacy Task 迁移 | 现有 Task/Revision 语义不变，新增 Ledger 可审计 |
| INT-06 | 多 Run legacy proposal | 不创建 Task Ledger，不执行旧 Run |
| INT-07 | delegated child 和 handoff target create | source refs、Task identity 和现有结果投递保持正确 |
| INT-08 | Event seq 或 Requirement 关联被破坏 | audit 返回 blocked，不继续追加事件 |
| INT-09 | 完整 task/recovery 测试 | 当前恢复、Revision switch 和 outbox 行为不回归 |
| INT-10 | Ledger 开关关闭、开启、关闭后再开启 | 关闭时不写；开启时双写；重新开启时幂等补齐且不重复 |

## 3. T-11：集成验证与模块文档

**输出文件**

- `docs/harness-module/protocol-runtime.md`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`
- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/session/recovery.test.ts`

**实现**

- 补充跨模块集成场景。
- 在独立进程中验证 `OPENCODE_EXPERIMENTAL_TASK_LEDGER` 默认关闭、显式开启和重启切换。
- 更新 protocol runtime 模块文档，写明 M0 数据权威边界、双写路径和未启用能力。
- 明确 M0 Event 尚不驱动 Scheduler，Graph 与 Checkpoint 尚未启用。

**验收**

- `task-ledger.test.ts` 全部通过。
- `task.test.ts` 全部通过。
- `recovery.test.ts` 全部通过。
- `bun typecheck` 通过。
- 文档与实际表、事件类型和写入边界一致。
- 开关关闭时 Ledger 行数不变，开启后生成完整事实，关闭后再开启不产生重复事实。

**规模**

- 文档变更 ≤ 120 行；测试新增 ≤ 10 个；涉及文件 4 个。

## 4. 回归边界

重点确认以下现有行为没有改变：

- 一个 Session 仍只有一个当前 Task。
- update/handoff 仍需 canonical confirmation/assignment。
- `task_revision.workflow` 仍是 M0 的执行兼容权威。
- `session_result` 仍是 child canonical result。
- 历史 Revision 不可恢复。
- 多 Run legacy proposal 不自动合并。
- TaskDocuments 发布失败不回滚数据库提交。

## 5. 完成门禁

- migration 可从迁移前 schema 升级。
- 新表外键检查通过。
- 无 Event seq 缺口。
- 无重复 command key。
- M0 audit 对全部新建 Task 返回 ok。
- 旧 Task 回填后返回 ok 或有明确 repairable 原因。
- 未实现的 Graph、Attempt、Checkpoint、Projection job 不在 UI/API 中伪装为可用。
