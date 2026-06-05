# v2 里程碑与验收

## 1. 阶段规划

| 里程碑 | 名称 | 目标 | 交付物 |
|---|---|---|---|
| M0 | Core Object Model | 梳理 Runtime、Resource、Agent、Handoff、Workflow、Memory 的对象边界。 | v2 schema 草案、对象关系图、ref 规则。 |
| M1 | Persistent Action Graph | Action Graph 可持久化、可查看、可恢复。 | Run store、Action Graph store、Event replay、Projection rebuild。 |
| M2 | Resource / Document Fabric | 大内容和中间过程资源化，session 只保留摘要和 refs。 | Resource Index、Document writer、model long output policy、resource explorer。 |
| M3 | Context Compiler | Runtime 编译模型上下文，控制 token、visibility 和 redaction。 | Context compiler、context preview、ref expansion policy、excluded records。 |
| M4 | Agent Definition and Assignment | Agent 定义、分类、权限和 Assignment 路径落地。 | Agent registry、kind 分类、entry/capability/permission、agent assignment。 |
| M5 | Handoff Protocol | `assign`、`handoff`、`sync` 持久化，并用 refs 交接。 | Handoff records、assignment builder、handoff writer、sync normalizer。 |
| M6 | Task Acceptance and Quality Gates | 为每个任务建立验收标准和验收策略，按标准与风险触发自动校验、Agent 审查、人工验收或组合验收。 | Acceptance criteria、acceptance policy、acceptance gate、evidence checker、repair routing、acceptance projection。 |
| M7 | Workflow Asset | Workflow 成为可保存、可版本化、可恢复的 Action Graph Profile。 | Workflow asset、workflow run、DAG projection、node recovery。 |
| M8 | Memory Mechanism | Memory 从 Resource、Trace、Sync 和用户确认中沉淀。 | Memory store、candidate review、scope precedence、memory refs。 |
| M9 | Governance UI | 用户能查看、恢复、交接、编辑、导出治理对象。 | Run Console、Resource Explorer、Agent Manager、Handoff View、Workflow Panel、Memory Panel、Trace View。 |
| M10 | Performance and Scalability | 根据高数据量和高并发路径建立性能基线，提升用户体验。 | Capacity model、query/index plan、scheduler backpressure、UI performance budget、observability metrics。 |
| M11 | Team / SDK / Evaluation | 团队化、SDK 和评测能力接入同一协议路径。 | Auth、PostgreSQL/object storage、SDK、Trace export、Evaluation Adapter。 |

## 2. M0：Core Object Model

验收标准：

- AC-M0-001：核心对象被分为事实、视图、证据、资源、上下文、策略六类。
- AC-M0-002：每个对象有稳定 id、schema version、producer、visibility 和 lifecycle 字段规划。
- AC-M0-003：Reference Protocol 能覆盖 Resource、Document、Artifact、Action、Handoff、Trace、Projection、Memory 和 Snapshot。
- AC-M0-004：v1 Artifact / Context / Memory / Workflow 语义能映射到 v2 对象，不丢失原有范围。

## 3. M1：Persistent Action Graph

验收标准：

- AC-M1-001：每次 `kind: "act"` 被接受后写入 Action Graph record。
- AC-M1-002：节点、依赖边、状态、criteria、failure、gate、budget、visibility 和 expected artifacts 可查询。
- AC-M1-003：Runtime 重启后可从 Event、Action Graph、Resource Index 和 Snapshot 判断节点状态。
- AC-M1-004：UI 可查看历史 Action Graph、当前节点状态、阻塞原因和恢复入口。
- AC-M1-005：Action 支持 idempotency、resource lock、cancellation 和 retry policy。

## 4. M2：Resource / Document Fabric

验收标准：

- AC-M2-001：Tool output、model long output、review report、test report、research note、handoff state 和 context snapshot 可写成 Resource。
- AC-M2-002：Resource Index 记录 id、kind、uri、summary、producer、source action、visibility、evidence、lifecycle 和 timestamps。
- AC-M2-003：超过阈值的模型输出默认写成 Document，session message 只显示标题、摘要、refs 和下一步建议。
- AC-M2-004：Trace、Projection、Handoff、Workflow 和 Memory 引用 Resource refs，不复制完整内容。
- AC-M2-005：Resource 支持 preview、summary、full read、redacted export 和 tombstone。

## 5. M3：Context Compiler

验收标准：

- AC-M3-001：模型上下文由 Runtime 根据 Assignment contract、Projection、Resource refs、Handoff refs、Memory refs 和用户最新输入编译。
- AC-M3-002：Context Bundle 显示 included、excluded、summary、refs、token budget 和 visibility。
- AC-M3-003：ref 展开支持 summary、structured、full、on_failure、on_demand 和 adaptive。
- AC-M3-004：Runtime 可以因 token、privacy、freshness 或 safety 降级上下文粒度。
- AC-M3-005：Context preview 能解释某条内容为什么进入或未进入模型上下文。

## 6. M4：Agent Definition and Assignment

验收标准：

- AC-M4-001：Agent Template 支持 identity、kind、entry、capability、permission、model_preference、execution_mode、relationships 和 orchestration_policy。
- AC-M4-002：Agent kind 使用 `planner`、`worker`、`verifier`、`helper` 四类粗粒度分类。
- AC-M4-003：Agent Session 与 Agent Template 分离，Session 绑定 Assignment、authority、Context Bundle summary 和 Trace refs。
- AC-M4-004：`type: "agent"` 的 Action 能创建 Assignment 和 Agent Session。
- AC-M4-005：Routing 不只按名称选择 Agent，而是结合 entry、capability、permission、relationships、availability、budget 和 current Projection。

## 7. M5：Handoff Protocol

验收标准：

- AC-M5-001：系统支持 `assign`、`handoff`、`sync` 三类通信原语。
- AC-M5-002：每个 communication primitive 都生成 canonical Handoff Record。
- AC-M5-003：Handoff Record 存 source、target、summary、state、evidence、risks、unresolved、next 和 refs，不存完整 transcript。
- AC-M5-004：下游 Agent 接收 handoff_ref、resource refs、projection ref 和 trace ref，再由 Context Compiler 生成上下文。
- AC-M5-005：review、repair、verify、manual switch、context limit 和 recovery 场景都能用三原语表达。

## 8. M6：Task Acceptance and Quality Gates

任务验收是 Runtime 机制，不是模型自觉。每个 Run、Action Graph、Action、Assignment 和 Workflow node 在创建时都应有 Acceptance Criteria。Runtime 根据验收标准、任务风险、写入范围、产物类型、权限、历史质量和用户策略生成 Acceptance Policy，并决定验收方式。

### 8.1 验收对象

| 对象 | 验收关注点 |
|---|---|
| Run | 用户目标是否完成，必要子任务、证据、产物、未决问题和最终回答是否闭合。 |
| Action Graph | 图级 criteria 是否满足，关键路径是否完成，required gates 是否通过。 |
| Action | 单个执行单元是否满足 criteria，输出是否有证据和 Resource refs。 |
| Assignment | Agent 是否完成 contract，authority 是否合规，结果是否可被 parent 消费。 |
| Workflow node | 节点 criteria 是否满足，下游依赖是否可以继续。 |
| Resource | 产物是否存在、可读、可引用、可脱敏，summary 是否足够。 |

### 8.2 验收分级

| 等级 | 适用任务 | 验收方式 |
|---|---|---|
| `none` | 只读、低风险、无持久产物的小查询。 | 记录 Trace，可抽样审计。 |
| `auto` | schema 明确、结果可机器校验的任务。 | schema、resource、criteria、evidence 自动检查。 |
| `test` | 代码、配置、工作流、数据处理等可验证任务。 | 执行测试、检查命令结果和测试 Resource。 |
| `agent` | 代码、文档、设计、调研、handoff 等需要判断质量的任务。 | 创建 verifier / reviewer assignment。 |
| `human` | 高风险写入、发布、权限变更、数据迁移、Memory promotion、外部服务操作。 | 创建 Decision 或 approval gate。 |
| `combined` | 大任务、跨 Agent 任务、关键 Workflow。 | 自动检查 + 测试 + reviewer + 必要人工确认。 |
| `sampled` | 大量重复低风险任务。 | 按比例抽样验收，异常时提高验收等级。 |

### 8.3 验收类型

| 类型 | 检查内容 | 典型产物 |
|---|---|---|
| schema acceptance | 输出结构、状态、字段、refs 是否符合协议。 | validation report |
| evidence acceptance | 结论是否有 Resource、Trace、Event 或 test refs 支撑。 | evidence report |
| artifact acceptance | 产物是否存在、可读、可引用、可脱敏。 | artifact check |
| test acceptance | 测试是否真实运行，失败是否被保留，结果是否可复现。 | test report |
| reviewer acceptance | 改动正确性、回归风险、测试覆盖、权限边界、文档质量。 | review report |
| handoff acceptance | done、current、next、risks、unresolved、refs 是否足够接续。 | handoff quality report |
| memory acceptance | Memory 是否准确、可追溯、不过期、不泄露敏感信息。 | memory review |
| human acceptance | 用户或 Owner 对高影响任务做取舍。 | decision record |

### 8.4 Acceptance Gate 结果

Acceptance Gate 支持以下结果：

- `approved`：任务可以关闭或进入下游消费。
- `changes_requested`：创建 repair assignment。
- `needs_evidence`：要求来源任务补充 Resource refs 或测试证据。
- `needs_user_decision`：创建 Decision。
- `blocked`：阻塞任务，等待外部条件。
- `waived`：由有权限用户跳过本次验收，并记录原因。

### 8.5 验收标准

- AC-M6-001：Run、Action Graph、Action、Assignment 和 Workflow node 都能绑定 Acceptance Criteria。
- AC-M6-002：Runtime 能根据 Acceptance Criteria 生成 Acceptance Policy。
- AC-M6-003：Acceptance Policy 可根据 risk、side_effects、resource scope、artifact type、agent kind、permission 和 user/team policy 推导验收等级。
- AC-M6-004：低风险任务可走自动检查，高风险任务必须进入 Agent review、human acceptance 或 combined acceptance。
- AC-M6-005：Acceptance Gate 写入 Event、Projection 和 Trace，并引用相关 Resource。
- AC-M6-006：Run 和 Action Graph 未满足 required Acceptance Gate 时不能进入 completed，可进入 partial、blocked 或 waiting_user。
- AC-M6-007：`changes_requested` 可自动创建 repair assignment，并保留原验收证据。
- AC-M6-008：`needs_evidence` 不允许任务直接 completed，应进入 blocked 或 waiting state。
- AC-M6-009：Memory promotion、handoff 接力、代码写入、发布、外部服务调用必须有非 `none` 验收策略。
- AC-M6-010：UI 能展示每个任务的验收标准、验收方式、验收者、证据、结论和后续动作。

## 9. M7：Workflow Asset

验收标准：

- AC-M7-001：Workflow Profile 可定义 goal、inputs_schema、nodes、depends_on、criteria、failure、gate、loop、budget、artifacts、visibility 和 handoff。
- AC-M7-002：Workflow 可从 UI 创建、从 Run 保存、由 Agent 生成后确认保存、或从外部导入。
- AC-M7-003：Workflow Asset 带 owner、version、source、visibility、created_at 和 updated_at。
- AC-M7-004：Workflow Run 展开为普通 Action Graph，进入统一 Event、Projection、Trace 和 Resource 路径。
- AC-M7-005：失败节点可查看证据、重试、跳过、转 repair assignment 或请求用户决策。
- AC-M7-006：Workflow node 可继承或覆盖 Acceptance Criteria 和 Acceptance Policy，关键节点未通过 Acceptance Gate 时不能继续下游消费。

## 10. M8：Memory Mechanism

验收标准：

- AC-M8-001：Memory 支持 run、project、team、global scope。
- AC-M8-002：Memory candidate 可从 Resource、Trace、Sync、用户显式保存和 Workflow 复盘生成。
- AC-M8-003：Memory record 带 summary、scope、namespace、source refs、evidence refs、visibility、status 和 freshness。
- AC-M8-004：Memory promotion 需要 acceptance gate 或明确策略，不能把 raw transcript 自动长期保存。
- AC-M8-005：Context Compiler 使用 scope precedence，当前 Projection 覆盖历史 Memory。

## 11. M9：Governance UI

验收标准：

- AC-M9-001：Run Console 展示 Run、Action Graph、Assignment、Decision、Resource、Trace 和恢复入口。
- AC-M9-002：Resource Explorer 展示资源树、摘要、来源、refs、visibility、lifecycle 和 redaction 状态。
- AC-M9-003：Agent Manager 展示 Agent 分类、入口、能力、权限、关系、编排策略和诊断。
- AC-M9-004：Handoff View 展示 assign / handoff / sync 链路和交接资源。
- AC-M9-005：Workflow Panel 展示资产、版本、DAG、运行历史、节点状态和恢复操作。
- AC-M9-006：Memory Panel 展示当前上下文使用了哪些 Memory、哪些被排除、哪些待确认。
- AC-M9-007：Acceptance View 展示每个任务的 Acceptance Criteria、Acceptance Gate、验收结论、证据和 repair 链路。

## 12. M10：Performance and Scalability

性能优化先分析数据量和并发来源，再决定索引、缓存、异步化、分页和 UI 渲染策略。目标不是让单个页面看起来更快，而是让长任务、多 Agent、Workflow、大 Resource 和高频 UI 订阅同时存在时，系统仍然可用。

### 12.1 高数据量路径

| 路径 | 数据增长来源 | 优化方向 |
|---|---|---|
| Event Log | 每个 Command、Action、Assignment、Gate、Decision、Resource 和 recovery 都会追加事件。 | append-only 写入、按 run/seq/type 索引、范围分页、事件摘要和归档。 |
| Action Graph | Workflow、loop、retry、parallel action 和多 Agent 编排会产生大量节点和边。 | graph projection cache、节点分页、子图加载、ready set materialization。 |
| Trace | 调试、审计和评测需要保留细粒度证据。 | trace summary 与 raw trace 分离、按 action/assignment/resource 建索引、按需展开。 |
| Acceptance Records | 每个任务可能产生 acceptance gate、review report、test report、repair chain 和 waiver。 | 按 task/reviewer/status 建索引、acceptance summary cache、repair chain projection。 |
| Resource Index | 长输出、报告、日志、文档、快照和 handoff state 持续增长。 | metadata 热存储、body 冷存储、摘要缓存、lifecycle policy、tombstone。 |
| Memory Store | project/team/global 记忆会跨 run 累积。 | scope + namespace 索引、freshness 排序、候选审核、失效和归档。 |
| Session Tree | root、child、descendant Agent Session 形成多层结构。 | 轻量 session list、按需加载 child、descendant count cache。 |
| UI Projection | Run list、timeline、graph、resource explorer、memory panel 读取大集合。 | projection-specific query、游标分页、增量订阅、虚拟列表和后台预取。 |

### 12.2 高并发路径

| 路径 | 并发来源 | 优化方向 |
|---|---|---|
| Scheduler | 多个 ready Action、Workflow nodes、Agent Sessions 同时可运行。 | max_parallel、resource lock、queue backpressure、priority 和 cancellation。 |
| Executor | tool、agent、runtime、human、service executor 同时执行。 | per-executor concurrency limit、timeout、heartbeat、orphan recovery。 |
| Resource Write | 大输出写入、摘要生成、索引更新、redaction export 并行发生。 | async job、streaming write、write lock、idempotency key、retry queue。 |
| Acceptance Queue | 大量任务完成后同时进入自动检查、测试验收、Agent review 或 human decision。 | priority、dedupe、batch check、reviewer concurrency limit。 |
| Context Compiler | 多 Agent 同时请求上下文。 | context cache、ref expansion budget、memory query limit、large ref lazy loading。 |
| UI Subscription | 多面板同时订阅 Projection、Trace、Resource 和 session state。 | event coalescing、debounce、server-side diff、client cache。 |
| API / SDK | UI、CLI、SDK 同时提交 Command 或查询状态。 | rate limit、idempotent command、read replica path、request budget。 |

### 12.3 用户体验目标

- Run list 默认返回轻量 Projection，不携带 raw context、raw trace 或 Resource body。
- Action Graph 首屏展示当前关键路径和阻塞节点，完整图按需展开。
- Trace Timeline 默认展示关键摘要，raw trace 和 executor logs 按需加载。
- Resource Explorer 默认展示 metadata 和 summary，全文预览懒加载。
- Context preview 展示 included/excluded 和 token budget，不自动展开大文档。
- Workflow Panel 对大 DAG 使用分层视图，避免一次渲染全部节点。
- Memory Panel 默认按当前 run 相关性排序，不扫描全部历史。
- Acceptance View 默认显示未通过、待证据、待用户决策和被 waiver 的任务。

### 12.4 验收标准

- AC-M10-001：列出 Event、Action Graph、Trace、Acceptance Records、Resource、Memory、Session Tree、Projection、Scheduler、Executor、Context Compiler、UI Subscription 的容量模型。
- AC-M10-002：每条高数据量路径都有分页、索引、摘要或冷热分层策略。
- AC-M10-003：每条高并发路径都有并发上限、背压、超时、取消或重试策略。
- AC-M10-004：Run list、Action Graph、Trace Timeline、Acceptance View、Resource Explorer 和 Workflow Panel 都有首屏数据预算。
- AC-M10-005：Context Compiler 有 ref 展开预算和 token budget，不能因为 Resource 增长无限扩大模型输入。
- AC-M10-006：Scheduler 暴露 queue depth、ready actions、running executors、blocked resources、retry count 和 cancellation count。
- AC-M10-007：Resource 写入、摘要生成、redaction export 和 trace export 走异步队列，失败可重试且不会阻塞主状态更新。
- AC-M10-008：系统记录慢查询、慢 projection rebuild、慢 context compile、慢 resource preview 和 UI subscription backlog。
- AC-M10-009：性能回归测试覆盖一个大 Run：至少 500 个 events、100 个 actions、50 个 resources、10 个 child sessions、20 个 acceptance records 和 3 个并发 Agent Sessions。

## 13. M11：Team / SDK / Evaluation

验收标准：

- AC-M11-001：支持本地 SQLite 和团队 PostgreSQL / object storage adapter。
- AC-M11-002：权限覆盖 user、project、team、agent、resource 和 trace export。
- AC-M11-003：SDK 支持 Command、Projection query、Trace export、Agent、Workflow、Memory 和 Resource 管理。
- AC-M11-004：Evaluation Adapter 使用 Trace、Resource、Outcome、Metric 和 Regression Gate。
- AC-M11-005：Model Policy 支持 provider、model、budget、fallback、cache 和 context budget。

## 14. 全局原则

| 原则 | 验收方式 |
|---|---|
| 会话不是数据库 | 重要事实能在 Event、Projection、Trace 或 Resource 中找到。 |
| transcript 不是上下文 | 模型输入来自 Context Compiler，而不是完整历史消息。 |
| 大内容不进消息 | 长输出、报告、日志和中间过程写成 Resource。 |
| 交接传 refs | Handoff 传资源路径、摘要和未决问题，不复制全文。 |
| 状态可恢复 | Runtime 能从 Event、Action Graph、Resource Index 和 Snapshot 恢复。 |
| 证据可审计 | 每个状态变化能追到 Event、Trace、Resource 或 Decision。 |
| 任务可验收 | 每个 Run、Action Graph、Action、Assignment 或 Workflow node 都有 Acceptance Criteria、Acceptance Policy 和可解释的验收结果。 |
| 版本可迁移 | 核心对象带 schema version，旧资源可查看、可迁移或明确标记不可运行。 |
| 性能可解释 | 高数据量和高并发路径都有指标、预算、降级和回归测试。 |
