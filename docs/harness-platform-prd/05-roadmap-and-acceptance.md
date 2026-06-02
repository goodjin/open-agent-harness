# 里程碑与验收计划

## 1. 阶段规划

| 阶段 | 名称 | 目标 | 交付物 |
|---|---|---|---|
| Phase 0 | 协议和 Runtime Kernel 骨架 | 打通 Run、Command、Action、Event、Projection、Trace 的最小闭环。 | Runtime API、schema、event store、projection、basic UI。 |
| Phase 1 | Model Protocol 与 Executor | 打通模型 DSL、toolCall carrier、Action Graph、tool executor、human decision。 | Model Gateway、Action scheduler、tool executor、Decision Queue。 |
| Phase 2 | Agent Session 与多 Agent 协作 | 支持 Agent Template、Agent Session、Assignment、routing、handoff、child trace。 | Agent Manager、Session Workbench、多 Agent routing。 |
| Phase 3 | Context、Memory、Visibility | 支持 Context Bundle、Memory scope、Observation、Artifact refs、redaction。 | Context Service、Memory Store、Visibility Policy、Artifact Index。 |
| Phase 4 | Workflow Adapter | 支持 durable DAG、bounded loop、verification、adapter state 和 recovery。 | Workflow Profile、Workflow Panel、replay/rehydration。 |
| Phase 5 | 产品化和团队能力 | 支持 team server、auth、trace export、evaluation adapter、model policy。 | Team deployment、Evaluation Adapter、Model Policy、SDK。 |

## 2. MVP 范围

MVP 聚焦单用户本地环境，目标是证明协议和 Runtime 治理闭环。

### 2.1 MVP 必备

- 创建 Run。
- 模型输出 `act/answer/done`。
- toolCall carrier 进入协议路径。
- 直接 tool request 可安全恢复为 Action。
- Action Graph 支持依赖和并行 ready nodes。
- Tool executor 可执行本地安全工具。
- Human executor 可创建 Decision。
- Event Log 持久化。
- Projection 可读。
- Trace 可展示。
- Artifact Index 可引用。
- Context Bundle 使用 Projection、Artifact refs 和 Memory refs。
- UI 展示 Run、Action Graph、Action detail、Decision、Trace 和 Artifact。

### 2.2 MVP 延后

这些能力进入后续阶段：

- 团队多租户和组织级权限。
- Evaluation Adapter。
- Model Policy 的完整策略系统。
- Release Gate Adapter。
- Long-running Monitor Adapter。
- Go sandbox worker。
- 云端分布式调度。

## 3. 阶段验收

### Phase 0：Runtime Kernel 骨架

验收标准：

- AC-P0-001：提交 `run.create` Command 后，系统写入 `run.created` Event。
- AC-P0-002：Projection 可返回 Run list 和 Run detail。
- AC-P0-003：Event 有单调 seq、稳定 id、time、actor、type、scope 和 data。
- AC-P0-004：Projection 可从 Event 重建。
- AC-P0-005：UI 通过 Projection 展示 Run 状态。

### Phase 1：Model Protocol 与 Executor

验收标准：

- AC-P1-001：Runtime 可解析 `kind: "act"`，并创建 Action Graph。
- AC-P1-002：Runtime 可解析 `kind: "answer"` 并返回用户可见回答。
- AC-P1-003：Runtime 可通过 toolCall carrier 接收协议对象。
- AC-P1-004：Runtime 可恢复安全 direct tool request，并记录 recovered origin。
- AC-P1-005：Tool executor 执行后写入 result、Artifact、Event 和 Trace。
- AC-P1-006：需要用户判断时创建 Decision，并进入 `waiting_user` 或 `waiting_permission`。

### Phase 2：Agent Session 与多 Agent 协作

验收标准：

- AC-P2-001：Agent Template registry 支持 package、user、project source。
- AC-P2-002：Agent Manager 可展示和编辑 user/project Agent。
- AC-P2-003：Agent Action 可创建 Assignment 和 Agent Session。
- AC-P2-004：Agent Session 有 session log、authority、Context Bundle summary 和 trace refs。
- AC-P2-005：Routing 支持 `target: "auto"`。
- AC-P2-006：Handoff Contract 可创建后续 Assignment。
- AC-P2-007：用户可进入 child Agent Session 并提交 `session.message.submit`。

### Phase 3：Context、Memory、Visibility

验收标准：

- AC-P3-001：Context Bundle 包含 goal、Projection、Artifact refs、Memory refs、约束、依赖和语义解释。
- AC-P3-002：Memory 支持 run、project、team、global scope。
- AC-P3-003：Visibility 控制 model、user、logs、trace、future_runs 和 runtime_only。
- AC-P3-004：Runtime Observation 按 result policy 生成 summary、structured、full、on_failure、on_demand 或 adaptive。
- AC-P3-005：Trace export 应用 redaction policy。

### Phase 4：Workflow Adapter

验收标准：

- AC-P4-001：Workflow Profile 可定义 goal、nodes、depends_on、criteria、failure、budget、visibility、artifacts 和 handoff。
- AC-P4-002：Workflow Profile 展开为 Harness Action Graph。
- AC-P4-003：Workflow DAG 支持 ready、running、blocked、partial、failed、completed 投影。
- AC-P4-004：Bounded loop 支持 max_attempts 和 until。
- AC-P4-005：Verification gate 可阻塞或推进 workflow。
- AC-P4-006：进程重启后可恢复 workflow run。

### Phase 5：产品化和团队能力

验收标准：

- AC-P5-001：支持 PostgreSQL 和 object storage。
- AC-P5-002：支持用户、项目、团队级权限。
- AC-P5-003：Trace export 可用于审计和评测。
- AC-P5-004：Model Policy 可控制 provider、model、budget、fallback 和 cache。
- AC-P5-005：Evaluation Adapter 支持 Trial、Grader、Outcome、Metric 和 Regression Gate。
- AC-P5-006：SDK 可提交 Command、查询 Projection、导出 Trace、管理 Agent。

## 4. 版本功能矩阵

| 能力 | MVP | v1.0 | v1.5 |
|---|---|---|---|
| Run / Command / Event / Projection | 支持 | 完善 | 团队级 |
| Model Protocol DSL | 支持 | 完善 | 多 provider 策略 |
| Tool executor | 支持 | 完善 | sandbox worker |
| Agent Session | 基础 | 多 Agent 编排 | 评测优化 |
| Human Decision | 基础 | 审批策略 | 组织流程 |
| Trace | 基础展示 | export / audit | evaluation dataset |
| Artifact Index | 基础 | object storage | lifecycle policy |
| Context Bundle | 基础 | Memory / redaction | personalized policy |
| Workflow Adapter | 延后 | 支持 | 高级恢复 |
| Evaluation Adapter | 延后 | 延后 | 支持 |
| Model Policy | 延后 | 基础 | 完整 |

## 5. 全局验收清单

| 类别 | 验收项 |
|---|---|
| 协议一致性 | 所有模型请求、toolCall、UI Command 和 Workflow Adapter operation 进入统一 Action/Event/Projection 路径。 |
| 状态可信 | UI 默认读取 Projection；Event 可 replay；Projection stale 时阻止 mutation。 |
| 多 Agent 可控 | 每个 Agent Session 有 Assignment、authority、Context Bundle、session log 和 Trace。 |
| 上下文可解释 | 模型输入来自 Context Bundle，并能说明来源、visibility 和 evidence。 |
| 执行可恢复 | Manifest、Snapshot、Event、Materialized State 和 Artifact refs 可支持 rehydration。 |
| 用户可治理 | 用户可查看阻塞原因、审批权限、进入子 session、重试任务、导出 Trace。 |
| Agent 可读 | Artifact、Trace、Projection 和 UI records 具有稳定 id、summary、refs 和 evidence。 |

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 协议字段过多导致模型输出不稳定 | Action 解析失败、恢复成本增加。 | 模型侧使用扁平 `kind/message/calls`；复杂对象由 Runtime 展开。 |
| Runtime Kernel 一开始承担过多 Adapter 逻辑 | 核心复杂度上升，难以测试。 | Kernel 只定义基础对象和状态机；Workflow/Evaluation/Release 作为 Adapter。 |
| UI 直接读取 raw logs 或 transcript | 用户看到的状态与 Runtime 不一致。 | UI 默认读取 Projection；raw logs 只作为证据入口。 |
| 多 Agent 自动编排成本过高 | 执行慢、费用高、结果难聚合。 | Routing 前评估适用条件，并用 budget / max_depth / dedupe_key 控制。 |
| 恢复语义不完整 | 长任务失败后无法继续。 | Phase 0 就建立 Event/Projection/replay；Phase 4 完成 Manifest/Snapshot/Rehydration。 |
| 当前项目迁移包袱影响新项目结构 | 新系统延续 chat/session 状态根。 | 只参考成熟模块，不沿用 Session-first 状态模型。 |

## 7. 待讨论问题

| 编号 | 问题 | 影响 |
|---|---|---|
| Q-001 | Team Server 的账户、项目、组织和权限模型如何定义？ | 影响多用户协作、审计和部署。 |
| Q-002 | Model Policy 的最小策略集合是什么？ | 影响 provider selection、fallback、cache 和成本控制。 |
| Q-003 | Evaluation Adapter 的数据集、Trial、Grader 和 Regression Gate 如何设计？ | 影响质量评测和版本回归。 |
| Q-004 | Sandbox 的首版边界选择是什么？ | 影响本地执行安全、实现成本和用户体验。 |
| Q-005 | Artifact 存储生命周期如何定义？ | 影响磁盘占用、审计保留和隐私合规。 |
| Q-006 | Workflow Adapter 与外部 Temporal / Cloudflare Workflows 的接入边界如何定义？ | 影响长任务部署和外部编排互操作。 |
| Q-007 | Agent 模板发布、版本、灰度和回滚如何定义？ | 影响 Agent marketplace 和团队治理。 |

