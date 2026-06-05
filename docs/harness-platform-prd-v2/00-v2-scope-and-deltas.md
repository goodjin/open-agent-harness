# v2 范围与增量

## 1. v1 完成度判断

`docs/harness-platform-prd/` 已经完成 v1 PRD 文档集：

- `00-product-vision-and-scope.md` 定义产品目标、范围、核心对象和原则。
- `01-users-and-usage-flows.md` 定义用户画像、核心场景和端到端流程。
- `02-protocol-and-governance-requirements.md` 定义模型协议、Action、Executor、Routing、Agent、Handoff、State、Context、Workflow 和 UI 管理协议。
- `03-functional-requirements.md` 定义功能模块、需求清单、用户故事和业务规则。
- `04-system-architecture-and-tech-stack.md` 定义架构目标、技术栈、数据层、Runtime Kernel、执行层、UI 和测试策略。
- `05-roadmap-and-acceptance.md` 定义 Phase 0-5、MVP、验收、风险和待讨论问题。

这里的“完成”指 PRD v1 文档结构和基线内容已经闭合，不表示系统实现已经完成。

## 2. v1 的主要缺口

v1 已经提出 `Artifact Index`、`Context Bundle`、`Memory`、`Trace`、`Snapshot` 和 `Workflow Adapter`，但这些对象之间还缺一条更强的底层机制。

当前缺口：

- 大内容如何从 session context 移出。
- 模型长输出如何写成文档资源。
- Action Graph、Handoff、Workflow 中间过程如何持久化。
- 下游 Agent 如何只拿资源路径和摘要，而不是完整 transcript。
- 每个任务如何声明验收标准，并由 Runtime 选择合适的验收方式，而不是依赖模型自觉。
- Context Bundle 如何由 Runtime 编译，而不是由调用方临时拼接。
- Resource ref 如何解析、授权、脱敏、摘要和按需展开。
- 旧版本 Workflow、Agent metadata、Memory 和 Handoff record 如何迁移。
- Resource 的保留、归档、删除和 tombstone 如何管理。
- Action Graph、Trace、Resource、Memory、Workflow 和 UI 查询在大数据量或高并发下如何保持可用。

## 3. v2 目标

v2 的目标是建立 Resource-first Harness：

```txt
Model / UI / Adapter intent
  -> Runtime accepts
  -> Event records accepted facts
  -> Projection exposes current view
  -> Trace links evidence
  -> Resource stores large content and documents
  -> Context Compiler selects minimal model context
```

v2 不是增加更多聊天能力，而是减少会话对系统状态和模型上下文的承担。

## 4. v2 核心对象

| 对象 | 含义 |
|---|---|
| Resource | 可引用资源的统一抽象，覆盖文档、产物、日志、快照、报告、模型长输出和中间过程。 |
| Document | 面向人和 Agent 可读的 Resource，通常是 Markdown、JSON、HTML、diff 或 report。 |
| Reference | 指向 Resource、Action、Trace、Projection、Memory、Handoff 或 Snapshot 的稳定引用。 |
| Resource Index | Resource 的索引表，记录 id、kind、uri、summary、producer、visibility、evidence 和 lifecycle。 |
| Context Compiler | Runtime 组件，按目标、Projection、Resource refs、Memory refs、Handoff refs 和 token budget 编译模型输入。 |
| Handoff Record | `assign`、`handoff`、`sync` 的 canonical record，存摘要和 refs，不复制完整上下文。 |
| Acceptance Criteria | Run、Action Graph、Action、Assignment 或 Workflow node 的完成判定标准。 |
| Acceptance Gate | Runtime 为任务生成的验收门禁，定义验收方式、验收者、证据、结果和后续动作。 |
| Acceptance Policy | 根据验收标准、风险、写入影响、资源范围、产物类型和历史质量决定验收路径的策略。 |
| Review Gate | Acceptance Gate 的一种形态，适用于需要 Agent reviewer 或 human reviewer 判断质量的任务。 |
| Workflow Asset | 可保存、可版本化、可运行的 Action Graph Profile。 |
| Memory Record | 从 Resource、Trace、Sync 或用户确认中沉淀出的跨 run 经验，带 scope、evidence 和 status。 |
| Performance Profile | 描述高数据量和高并发路径的容量模型、SLO、索引、缓存、背压、限流和观测指标。 |

## 5. 引用原则

推荐引用形态：

```txt
resource://<resource_id>
document://<document_id>
artifact://<artifact_id>
action://<action_id>
handoff://<handoff_id>
trace://<trace_id>
projection://run/<run_id>/current
memory://<memory_id>
snapshot://<snapshot_id>
```

每个 ref 都应支持：

- 解析到目标对象。
- 校验读取权限。
- 返回摘要。
- 按 visibility 展开内容。
- 应用 redaction。
- 暴露 evidence 和 producer。

## 6. 上下文原则

默认上下文不包含完整 transcript。

Context Bundle 应包含：

- 当前目标。
- 当前 Projection summary。
- 当前 Assignment contract。
- 必要 Resource refs。
- 必要 Handoff refs。
- 必要 Memory refs。
- 已排除内容及原因。
- token budget 和 visibility 说明。

Runtime 可以按需把 ref 展开为摘要、结构化片段或全文，但不能超出 visibility 和 redaction policy。

## 7. 持久化原则

以下内容都应持久化：

- Action Graph。
- Action records 和 dependency edges。
- Handoff records。
- Workflow Profile 和 Workflow Run。
- Resource Index。
- Model long output documents。
- Intermediate reports。
- Context snapshots。
- Trace entries。
- Memory candidates 和 approved memories。

会话消息只是交互界面，不作为事实来源和知识仓库。

## 8. 验收原则

Harness 面向各种任务，任务完成不能只依赖执行模型自报。

每个 Run、Action Graph、Action、Assignment 和 Workflow node 都应有 Acceptance Criteria。Runtime 根据验收标准生成 Acceptance Policy，再决定走自动校验、测试验收、证据验收、Agent 审查、人工验收、组合验收或抽样审计。

验收方式：

- schema acceptance：输出结构、字段、引用和状态是否符合协议。
- evidence acceptance：结果是否提供足够证据和 Resource refs。
- artifact acceptance：产物是否存在、可读、可引用、可脱敏。
- test acceptance：测试是否真实运行，失败是否被记录，结果是否可复现。
- reviewer acceptance：代码、文档、设计、调研或 Handoff 由 verifier / reviewer Agent 判断质量。
- human acceptance：高风险或模糊任务交给用户或 Owner 决策。
- sampled acceptance：大量重复低风险任务按比例抽样，异常时提高验收等级。

Acceptance Gate 的结果不只是通过或失败，还应支持：

- `approved`
- `changes_requested`
- `needs_evidence`
- `needs_user_decision`
- `blocked`
- `waived`

Runtime 根据结果决定关闭任务、创建 repair assignment、请求补充证据、升级给用户，或把任务标记为 partial / blocked / failed。`waived` 只表示有权限的用户跳过本次验收，不能删除原始风险和证据记录。

## 9. 性能原则

v2 的性能优化从数据路径分析开始，不从局部 UI 微调开始。

高数据量路径：

- Event Log：长任务和多 Agent 运行会产生大量事件。
- Action Graph：Workflow、loop、retry 和并行 Agent 会产生大量节点和边。
- Trace：每个 Action、Assignment、Executor、Gate、Decision 和 Observation 都会写入证据链。
- Resource Index：模型长输出、工具输出、测试报告、review、handoff state 和 context snapshot 会持续增长。
- Memory Store：project/team/global scope 的检索范围会跨 run 增长。
- Session tree：root、child、descendant Agent Session 会形成深层树。
- UI Projection：Run list、timeline、graph、resource explorer 和 memory panel 都可能查询大集合。

高并发路径：

- 多个 ready Action 并行调度。
- 多 Agent Session 同时运行。
- Workflow loop 和 retry 同时触发。
- Resource 写入、摘要生成、索引更新和 redaction export 并行发生。
- UI 多面板同时订阅 Projection、Trace 和 Resource 更新。
- SDK、CLI 和 UI 同时提交 Command 或查询 Projection。

性能基线应覆盖：

- 分页和游标。
- 索引和复合查询键。
- Projection cache 和增量更新。
- Resource 分层存储和懒加载。
- Trace summary 与 raw trace 分离。
- Context Compiler token budget 和 ref 展开预算。
- Scheduler parallelism、resource lock、queue backpressure 和 cancellation。
- 大对象异步写入、摘要生成和重试。
- UI 虚拟列表、graph 分层渲染和后台预取。
- 指标、采样、慢查询记录和容量压测。
