# Durable Task Persistence M0 开发计划

- Mission：`durable-task-persistence-m0`
- 日期：2026-07-23
- 状态：已完成；T-01—T-11 的实现、测试、审查与归档门禁均通过
- 设计来源：`docs/features/2026-07-23-durable-task-persistence-and-recovery-design.md`
- 目标：建立 Requirement、Resource、Task Event 和 Command 幂等基础，并让现有 Task 生命周期同步写入这些事实。

## 1. 实施边界

M0 采用旁路双写，不改变当前执行权威：

- `session_task`、`task_revision.workflow`、`assignment`、`session_result` 继续决定现有执行行为。
- 新增的 Requirement、Resource、Event 和 Command 用于审计、兼容性验证和后续 M1 Graph 迁移。
- M0 不接管 Scheduler，不修改 Session 启动恢复顺序，不新增 UI。
- M0 不把 `task_revision.body` 立即迁出 SQLite；先为现有正文和 assignment content 建立稳定 Resource 索引。
- Event 与对应 Task 状态在同一 SQLite 事务中提交。
- 现有 Task 没有 M0 数据时采用幂等懒回填，不在 migration 中猜测用户确认和执行结果。
- Ledger 写入由 `OPENCODE_EXPERIMENTAL_TASK_LEDGER` 控制，默认关闭；全局
  `OPENCODE_EXPERIMENTAL=true|1` 或专用变量为 `true|1` 时开启。
- 开关关闭时只加载 migration/schema，不写 Ledger、不触发懒回填；开启后在既有 Task 写边界双写，
  但不切换读取、调度、恢复或 UI 权威。

## 2. 模块清单

| 编号 | 模块 | 层次 | 数据实体 | 接口 | 状态机 | 优先级 |
|---|---|---|---:|---:|---:|---|
| MOD-01 | 持久化 Schema | 数据层 | 4 | 0 | 0 | P0 |
| MOD-02 | Task Ledger | 领域层 | 4 | 1 个内部 API 组 | Command/Event | P0 |
| MOD-03 | Task 生命周期双写 | Runtime | 现有 Task/Revision | 现有 API | Task/Revision | P0 |
| MOD-04 | 兼容回填与审计 | Runtime | 4 | 1 个内部 API 组 | Repair | P0 |
| MOD-05 | 集成测试与模块文档 | 测试/文档 | - | - | - | P0 |

## 3. 模块依赖

| 模块 | 依赖 | 开发顺序 |
|---|---|---|
| MOD-01 | 无 | 第 1 批 |
| MOD-02 | MOD-01 | 第 2 批 |
| MOD-03 | MOD-02 | 第 3 批 |
| MOD-04 | MOD-02、MOD-03 | 第 4 批 |
| MOD-05 | MOD-01—MOD-04 | 第 5 批 |

## 4. 交付物类型

| 模块 | 类型 | 验收方式 |
|---|---|---|
| MOD-01 | library | migration 和 Drizzle schema 一致，约束真实生效 |
| MOD-02 | library | 真实 SQLite 中 Command 去重、Event 连续递增 |
| MOD-03 | library | 现有 Task 行为不变，同时产生完整 Ledger |
| MOD-04 | library | 旧 Task 可幂等回填，歧义事实不被猜测 |
| MOD-05 | library | 聚焦测试、完整 Task 测试和 typecheck 通过 |

M0 没有表现组件，因此不安排前端计划或 app smoke test。

## 5. 开发任务

| 批次 | 任务 | 文档 | 依赖 |
|---|---|---|---|
| 1 | T-01 Schema 与 migration | `01-backend-m0-ledger.md` | - |
| 2 | T-02 Ledger 写入开关 | `01-backend-m0-ledger.md` | T-01 |
| 2 | T-03 Ledger contracts | `01-backend-m0-ledger.md` | T-02 |
| 2 | T-04 Command 幂等 | `01-backend-m0-ledger.md` | T-03 |
| 2 | T-05 Event 序列 | `01-backend-m0-ledger.md` | T-03 |
| 3 | T-06 Task 创建与 Requirement 双写 | `01-backend-m0-ledger.md` | T-04、T-05 |
| 3 | T-07 Revision 生命周期双写 | `01-backend-m0-ledger.md` | T-06 |
| 3 | T-08 Workflow 与结果事件双写 | `01-backend-m0-ledger.md` | T-07 |
| 4 | T-09 旧 Task 懒回填 | `01-backend-m0-ledger.md` | T-06—T-08 |
| 4 | T-10 Ledger 审计读取 | `01-backend-m0-ledger.md` | T-09 |
| 5 | T-11 集成验证与模块文档 | `02-integration-m0-ledger.md` | T-01—T-10 |

## 6. 需求覆盖

| 设计需求 | M0 覆盖 | 后续里程碑 |
|---|---|---|
| FR-01 原始需求持久化 | Requirement、source refs、body hash | M4 文档投影 |
| FR-02 定义/设计/计划分离 | Resource kind 和 ref 基础 | M4 文档正文迁移 |
| FR-07 防重复 | Command 幂等基础 | M2 Attempt fencing |
| FR-08 文档可重建 | T-01/T-03/T-06 建立 Resource 索引与 ref/hash 基础 | M4 正文校验与 Projection job |
| FR-09 兼容旧数据 | 幂等懒回填 | M5 Run/Graph 迁移 |
| FR-12 审计历史 | Task Event | M3 Checkpoint |

FR-03—FR-06、FR-10—FR-11 不在 M0 切换实现，由 M1—M5 继续覆盖。T-10 的内部审计只为
FR-10 提供基础，不代表 M0 已交付查询、恢复和人工处置接口。

## 7. 提交边界

每个任务完成聚焦测试后提交一次，提交范围只包含该任务列出的文件。建议提交顺序：

1. `feat(session): add durable task ledger schema`
2. `feat(session): gate durable task ledger writes`
3. `feat(session): record task commands and events`
4. `feat(session): persist task requirements and resources`
5. `feat(session): backfill durable task ledger`
6. `test(session): audit durable task ledger m0`

每个提交推送 `dev`，不带入 `.superpowers/` 或其他无关变更。

## 8. 验证命令

所有测试从 `packages/opencode` 运行：

```bash
bun test test/session/task-ledger.test.ts
bun test test/session/task.test.ts
bun test test/session/recovery.test.ts
bun typecheck
```

禁止从仓库根目录运行测试，禁止直接调用 `tsc`。

## 9. 实际交付与闭环

M0 从设计提交 `660dfaf68` 开始，到最终 admission gate 修复 `161cf4655` 完成。各任务的最终
证明提交如下：

| 任务 | 最终证明提交 | 交付结论 |
|---|---|---|
| T-01 | `7770602c7` | migration、schema ownership 与 journal 恢复通过 |
| T-02 | `0a6c9382a` | 默认关闭的 Ledger flag 通过 |
| T-03 | `4a28bc8e8` | 严格 contracts 与完整 Requirement history 通过 |
| T-04 | `2cdd6fd2d` | Command 幂等冲突边界通过 |
| T-05 | `392bcf95c` | Event 原子序列与 commit 后 effect 合并通过 |
| T-06 | `ad407e84a` | create、delegation、handoff 与 legacy 双写通过 |
| T-07 | `72bcd607a` | Revision lifecycle 与 canonical Command identity 通过 |
| T-08 | `64f5145e1` | workflow/result Event 与 canonical result locator 通过 |
| T-09 | `6ca623865` | 懒回填状态机与完整 Requirement 链验证通过 |
| T-10 | `ff06e052d` | 只读 audit 的 persisted-facts 证明边界通过 |
| T-11 | `161cf4655` | admission generation gate 与集成矩阵通过 |

最终 admission、Ledger、Task 测试为 177/177 通过、807 assertions；migration check 与
`bun typecheck` 通过。其余矩阵为 76/77；唯一失败是早于 M0 的 Recovery scoped-child
基线，Recovery 单组为 18/19，且在多个 M0 前置差分点复现。该后续项不属于 M0 变更，
也不扩大 M0 边界：Graph、Attempt、Checkpoint、Projection job、Event-driven Scheduler
和完整断点恢复仍由 M1—M5 交付。
