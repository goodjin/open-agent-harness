# 后端开发计划：M0 Task Ledger

- 模块：MOD-01—MOD-04
- 优先级：P0
- 设计来源：`docs/features/2026-07-23-durable-task-persistence-and-recovery-design.md`
- 交付物：库/模块

## 1. 技术路径

使用现有 Bun、TypeScript、Zod、Drizzle SQLite 和 `Database.transaction()`。新增领域代码放在 `packages/opencode/src/session/task-ledger.ts`，避免继续扩大 `task.ts` 的数据规约职责。

M0 沿用 `packages/opencode/src/flag/flag.ts` 的 experimental flag 约定，新增
`OPENCODE_EXPERIMENTAL_TASK_LEDGER`：

- 默认关闭；`OPENCODE_EXPERIMENTAL=true|1` 或专用变量为 `true|1` 时开启。
- 关闭时 migration/schema 正常加载，Task Runtime 不写 Ledger，也不触发 `ensure()`。
- 开启时只在现有 Task 写边界旁路双写；Ledger 不参与读取裁决、Scheduler、恢复或 UI。
- 测试通过新进程设置环境变量，避免模块级 flag 缓存污染同一测试进程。

M0 的 Resource 是索引：

- assignment 创建的任务引用现有 immutable assignment content；
- direct/legacy Task 引用当前 Revision body hash 和稳定内部 URI；
- 正文迁移到统一 content-addressed store 留到 M4；
- Resource row 不可原地改正文，只能创建新 id。

## 2. 表设计

### `task_requirement`

核心字段：`id`、`task_id`、`version`、`source_refs`、`body_ref`、`body_hash`、`constraints`、`acceptance`、`created_by`、`confirmed_at`、`supersedes_id`、`time_created`。

约束：

- `(task_id, version)` 唯一；
- `body_hash` 为 64 位 SHA-256；
- `supersedes_id` 只能指向同一 Task，由领域层校验；
- migration 回填的需求不设置 `confirmed_at`。

### `task_resource`

核心字段：`id`、`task_id`、`revision_id`、`kind`、`uri`、`hash`、`size`、`summary`、`producer_type`、`producer_id`、`visibility`、`lifecycle`、`time_created`。

约束：

- `(task_id, kind, hash, uri)` 唯一；
- M0 kind 只开放 `requirement`、`spec`、`plan`；
- M0 lifecycle 只写 `active` 或 `archived`。

### `task_event`

核心字段：`task_id`、`seq`、`id`、`type`、`revision_id`、`command_id`、`data`、`resource_refs`、`time_created`。

约束：

- 主键 `(task_id, seq)`；
- Event id 全局唯一；
- seq 由 `session_task.last_event_seq` 在同一事务中分配；
- Event payload 只保存小型 JSON。

### `task_command`

核心字段：`id`、`task_id`、`kind`、`idempotency_key`、`status`、`result_ref`、`time_created`、`time_applied`。

约束：

- `idempotency_key` 唯一；
- M0 status 为 `accepted`、`applied`、`rejected`；
- 重放命令返回已存在的 command，不重新追加 Event。

### 现有表增量

`session_task` 增加：

- `requirement_id`
- `status_reason`
- `last_event_seq NOT NULL DEFAULT 0`
- `checkpoint_id`
- `schema_version NOT NULL DEFAULT 1`

`task_revision` 增加：

- `requirement_id`
- `spec_ref`
- `design_ref`
- `plan_ref`
- `graph_id`
- `schema_version NOT NULL DEFAULT 1`

M0 只写 `requirement_id`、`spec_ref`、`plan_ref` 和 `schema_version`；`design_ref`、`graph_id` 留空。

## 3. 原子任务

### T-01：新增 Schema 与 migration

**输出文件**

- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/migration/20260723160000_durable_task_ledger/migration.sql`
- `packages/opencode/src/storage/schema.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 定义四张新表和现有表增量字段。
- 使用 snake_case 字段和明确索引。
- 把现有 Task 表及新表补入 storage schema export。
- migration 只建结构和默认值，不生成历史 Event。

**验收**

- 新数据库包含全部表、外键和唯一索引。
- 旧数据库 migration 后现有 Task 行仍可读取。
- 同一 Task 重复 requirement version、重复 Event seq、重复 command key 被数据库拒绝。

**规模**

- 源代码 ≤ 180 行；文件 3 个；测试 ≤ 6 个。

### T-02：增加 Ledger 写入开关

**输出文件**

- `packages/opencode/src/flag/flag.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 导出 `Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER`。
- 采用 `OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_TASK_LEDGER")`，默认关闭。
- 后续 Ledger 写边界统一读取该 flag，不在各调用点重复解析环境变量。

**验收**

- 两个环境变量均未设置时开关为 false。
- 专用变量为 `true`/`1` 时开启，为 `false`/`0` 时不单独开启。
- `OPENCODE_EXPERIMENTAL=true|1` 时统一开启。
- 开关关闭时现有 Task 路径不产生 Ledger row；该集成行为在 T-11 验证。

**规模**

- 源代码 ≤ 10 行；文件 1 个；测试 ≤ 4 个。

### T-03：定义 Ledger contracts 与查询

**输出文件**

- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 导出严格 Zod schema：Requirement、Resource、Event、Command、Snapshot。
- 提供 `requirements(taskID)`、`resources(taskID)`、`events(taskID, after, limit)`、`command(key)`。
- Event 查询按 seq 升序并强制有界 limit。
- 新标识符采用 `requirement_`、`resource_`、`event_`、`command_`。

**验收**

- 查询结果通过严格 schema。
- Event 游标不会重复或跳过符合范围的数据。
- 非法 limit、hash、kind 和 lifecycle 被拒绝。

**规模**

- 源代码 ≤ 180 行；文件 1 个；测试 ≤ 8 个。

### T-04：实现 Command 幂等边界

**输出文件**

- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 提供事务内 `claim(tx, input)` 和 `apply(tx, commandID, resultRef?)`。
- `claim` 对相同 idempotency key 返回原 Command。
- 同 key 但 kind/task identity 不一致时抛出 conflict。
- M0 command key 从稳定 source identity 构造，不使用时间戳。

**验收**

- 同一命令执行两次只生成一行。
- 并发 claim 只有一个创建者。
- identity drift 不会复用旧命令。

**规模**

- 源代码 ≤ 120 行；文件 1 个；测试 ≤ 6 个。

### T-05：实现事务内 Event 序列

**输出文件**

- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 提供 `append(tx, taskID, events)`。
- 在同一 immediate transaction 中读取并 compare-and-set `last_event_seq`。
- 批量 Event 获得连续 seq。
- command 重放不追加 Event。

**验收**

- 单次和批量 append 连续递增。
- 并发写没有重复 seq。
- Event 插入失败时 Task seq 同事务回滚。

**规模**

- 源代码 ≤ 150 行；文件 1 个；测试 ≤ 8 个。

### T-06：Task 创建时记录 Requirement 与 Resource

**输出文件**

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 在 canonical Task create、delegated create 和 handoff target create 的事务内写 Requirement/Resource。
- 仅在 `Flag.OPENCODE_EXPERIMENTAL_TASK_LEDGER` 开启时执行 Ledger 双写。
- source refs 保留 message、assignment、Run 和 Action identity。
- assignment path 的 `body_ref` 使用现有 content ref；direct/legacy path 使用稳定 Revision URI。
- 写 `task.created`、`requirement.recorded`、`revision.activated`。
- 回写 Task/Revision 的 requirement/ref 字段。
- 现有 Task 返回值和执行分支保持不变。

**验收**

- 一个 Task 只有一个 v1 Requirement。
- create 重放不产生第二套 Resource 或 Event。
- delegation、handoff 和 legacy source 保持可区分。
- 数据库事务失败不会留下部分 Ledger row。

**规模**

- 源代码 ≤ 200 行；文件 2 个；测试 ≤ 10 个。

### T-07：Revision 生命周期双写

**输出文件**

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task.test.ts`

**实现**

- `draft()` 和 update assignment 创建 draft 时记录新 Requirement/Resource。
- 开关关闭时沿用原事务，不创建 Requirement、Resource、Command 或 Event。
- 写 `revision.drafted`。
- `activate()` 与修订恢复激活路径写 `revision.archived`、`revision.activated`。
- 重放或 stale draft 拒绝不追加事件。
- 历史 Revision 的 Resource lifecycle 切换为 archived。

**验收**

- 每次成功 Revision 切换产生一组连续 Event。
- 两个 active Revision 约束保持不变。
- 恢复路径与普通激活产生相同事实，不重复写。

**规模**

- 源代码 ≤ 180 行；文件 2 个；测试 ≤ 8 个。

### T-08：Workflow 与结果事件双写

**输出文件**

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task.test.ts`

**实现**

- `sync()` 成功追加新 Run/Action 摘要时写 `task.workflow_synced`。
- 所有 Ledger 事件写入受统一开关控制，关闭时不改变原 workflow/result 路径。
- `finish()` 成功写结果时写 `result.recorded` 和对应 task terminal Event。
- 重复相同 finish 返回原结果且不重复写 Event。
- Event 只保存 run/action count、result source 和 result ref，不复制正文。

**验收**

- workflow 无变化时不写 Event。
- completed/failed/partial 的现有状态语义保持不变。
- canonical result 重放不会制造第二个 terminal Event。

**规模**

- 源代码 ≤ 160 行；文件 2 个；测试 ≤ 8 个。

### T-09：旧 Task 幂等懒回填

**输出文件**

- `packages/opencode/src/session/task-ledger.ts`
- `packages/opencode/src/session/task.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`
- `packages/opencode/test/session/task.test.ts`

**实现**

- 提供 `ensure(tx, task, revision)`。
- `ensure()` 只在开关开启且进入既有写边界时调用；关闭时不检查、不修复 Ledger。
- 没有 requirement/event 的现有 Task 写 migration Requirement、Resource 和 baseline Event。
- `confirmed_at` 留空，`created_by=migration`。
- baseline Event 只描述已知当前快照，不推断历史状态变化。
- `get/current/open` 进入现有写边界时触发；纯只读接口不做隐式修复。

**验收**

- 同一旧 Task 多次 ensure 结果一致。
- 已有部分 M0 数据时只补缺失事实。
- 多 Run、legacy result 和 archived Revision 不被错误重放。

**规模**

- 源代码 ≤ 180 行；文件 2 个；测试 ≤ 10 个。

### T-10：Ledger 审计读取

**输出文件**

- `packages/opencode/src/session/task-ledger.ts`

**测试文件**

- `packages/opencode/test/session/task-ledger.test.ts`

**实现**

- 提供 `audit(taskID)`，返回 `ok`、`repairable` 或 `blocked`。
- 检查 current Revision、requirement refs、Event seq、Requirement/Resource 中已持久化的 hash/ref
  交叉引用一致性和 command identity。
- M0 不自动修复 blocked；只返回机器原因。
- M0 不读取 Resource 正文、不按 URI 重算正文 hash，也不扫描完整历史 Run；正文可读性和内容 hash
  重算留到 M4。

**验收**

- 健康 Task 为 ok。
- 缺投影类 M0 字段为 repairable。
- Event seq 缺口、跨 Task Requirement 和已持久化 hash/ref 交叉引用不一致为 blocked。

**规模**

- 源代码 ≤ 180 行；文件 1 个；测试 ≤ 8 个。

## 4. 代码规范

- 新 locals、params、helpers 默认单词命名。
- 不引入 `any`。
- 避免无必要 destructuring、`else` 和 `try/catch`。
- Drizzle 字段使用 snake_case。
- 事务内 helper 接收 `Database.TxOrDb`，不在 helper 内打开嵌套事务。
- Task Event payload 不保存 secret、完整正文或 provider payload。

## 5. 测试要求

- 使用真实 SQLite 和现有 `Instance.provide()` 测试环境。
- 不 mock Ledger 状态机。
- 每个任务测试数不超过 10 个。
- 先写失败测试，再写实现。
- 聚焦测试从 `packages/opencode` 运行。
