# 用户画像与使用流程

## 1. 目标用户

### 1.1 个人开发者

| 字段 | 描述 |
|---|---|
| 目标 | 把复杂开发任务交给 Agent 执行，并能随时查看进度、证据、变更和失败原因。 |
| 典型任务 | 修 bug、补测试、阅读代码、生成文档、审查实现、运行验证。 |
| 关键诉求 | 本地可控、能恢复、能看到每一步做了什么、能进入子 Agent 会话补充信息。 |
| 关注功能 | Run Console、Protocol Panel、Agent Session Workbench、Artifact Index、Trace View、权限审批。 |

### 1.2 技术负责人 / 团队 Owner

| 字段 | 描述 |
|---|---|
| 目标 | 管理团队中的 Agent 执行质量、风险、权限和产物证据。 |
| 典型任务 | 审查自动修复任务、设置 release gate、查看失败原因、导出审计材料。 |
| 关键诉求 | 任务状态可信、证据链完整、权限边界清晰、失败后可定位和接续。 |
| 关注功能 | Governance View、Trace Export、Decision Queue、Agent Manager、Workflow Panel。 |

### 1.3 Agent 作者 / 平台配置者

| 字段 | 描述 |
|---|---|
| 目标 | 编写、导入、调试和发布可复用 Agent 模板。 |
| 典型任务 | 定义 Agent metadata、capability、permission profile、model preference、relationships、orchestration_policy。 |
| 关键诉求 | 定义简单、诊断明确、可测试、可观察、可灰度启用。 |
| 关注功能 | Agent Manager、Agent diagnostics、Capability routing preview、Session trace、template import。 |

### 1.4 评测 / 质量工程师

| 字段 | 描述 |
|---|---|
| 目标 | 用结构化 Trace、Artifact 和 Outcome 评估 Agent 行为质量。 |
| 典型任务 | 收集 trial、定义 grader、设置 regression gate、比较模型或 Agent 版本。 |
| 关键诉求 | 运行可复现、结果可比较、失败可追踪、评测数据可导出。 |
| 关注功能 | Trace Export、Artifact Index、Evaluation Adapter、Model Policy、Regression Gate。 |

### 1.5 平台运维 / 安全管理员

| 字段 | 描述 |
|---|---|
| 目标 | 控制模型、工具、网络、secret、workspace 和外部服务访问边界。 |
| 典型任务 | 配置 provider、设置 sandbox、管理权限策略、查看审计日志。 |
| 关键诉求 | 默认安全、可审计、可限流、可恢复、可导出。 |
| 关注功能 | Authority View、Sandbox Manifest、Audit Export、redaction policy、budget policy。 |

## 2. 核心使用场景

| 编号 | 场景 | 用户 | 价值 |
|---|---|---|---|
| S-001 | 受治理任务执行 | 个人开发者、团队 Owner | 把自然语言目标转换为可观察、可恢复的 Run。 |
| S-002 | 多 Agent 分工 | 个人开发者、团队 Owner | 将开发、测试、审查、研究等工作拆给不同 Agent Session。 |
| S-003 | 用户进入子 Session 交互 | 个人开发者 | 用户可以给某个 child session 补充信息，而不是只能跟 root session 对话。 |
| S-004 | 人工审批与决策 | 团队 Owner、安全管理员 | 高风险操作、权限请求、需求澄清和失败恢复进入 Decision Queue。 |
| S-005 | Workflow 长任务 | 团队 Owner、质量工程师 | 多阶段、跨 turn、可恢复任务用 Workflow Adapter 执行。 |
| S-006 | Agent 模板管理 | Agent 作者 | 创建、启用、诊断、禁用和导入 Agent 模板。 |
| S-007 | Trace 审计和导出 | 团队 Owner、质量工程师 | 导出执行证据，用于审查、复盘和评测。 |
| S-008 | 失败恢复 | 所有用户 | 从 Event、Projection、Artifact、Snapshot 和 Manifest 恢复运行。 |

## 3. 端到端流程

### Flow-001：创建并执行一个 Run

1. 用户在 Harness Console 输入目标，例如“修复登录超时 bug，并补充测试”。
2. Runtime 创建 `Run`，生成初始 Goal Contract。
3. Runtime 构造 Context Bundle，调用 root Agent Session。
4. 模型通过 Agent Protocol DSL 返回 `kind: "act"` 和 `calls[]`。
5. Runtime 将 calls 归一化为 Action Graph。
6. Runtime 校验 schema、authority、gate、budget 和 dependencies。
7. Runtime 将 ready Action 路由给 tool、Agent Session、Runtime service 或 human executor。
8. Executor 返回结果，Runtime 存储 Artifact、追加 Event、更新 Projection 和 Trace。
9. 需要下一轮模型判断时，Runtime 生成精简 Observation，重新构造 Context Bundle。
10. UI 持续展示 Run status、Action Graph、Assignment、Artifact、Decision 和 Trace。
11. Run 达到成功标准后进入 `completed`；如果部分必要项未完成，进入 `partial`；如果缺少决策，进入 `blocked` 或 `waiting_user`。

### Flow-002：开发、测试、审查的多 Agent 接力

```txt
User goal
  -> task_planner
  -> code_developer
  -> code_test
  -> technical_reviewer
  -> final answer / handoff
```

1. Runtime 根据任务可分解、上下文可隔离、结果可聚合和成本收益匹配，判断是否适合多 Agent。
2. Planner 或 root Agent 声明 Action Graph。
3. Runtime 创建 `code_developer` Assignment，绑定目标、约束、依赖、预算、Artifact 期望和 authority。
4. Developer 完成后产出 patch Artifact 和 unresolved issues。
5. Runtime 根据 Agent `orchestration_policy` 或 Action `handoff` 创建测试 Assignment。
6. Test Agent 读取 patch Artifact 和 criteria，运行验证并产出 test_report。
7. Review Agent 读取 patch、test_report 和 Trace，产出 review_report。
8. Parent Run 聚合下游结果，更新 final Projection。

### Flow-003：用户进入不同 Agent Session 交互

1. 用户在 Session Workbench 打开某个 child Agent Session。
2. UI 展示该 session 的 Assignment、authority、Context Bundle 摘要、Artifact refs、session log 和 Trace。
3. 用户提交补充信息，UI 发送 `session.message.submit` Command。
4. Runtime 校验该 Command 是否适用于目标 session。
5. Runtime 将用户输入记录为 Event，更新 Projection。
6. Runtime 为该 session 构造新的 Context Bundle，并继续模型调用或等待下一步。
7. 用户可以回到 parent run 查看聚合状态。

### Flow-004：人工审批与决策

1. Runtime 在执行前发现需要权限审批、需求澄清、风险选择或失败恢复决策。
2. Runtime 创建 Decision record，Run 或 Action 进入 `waiting_user` 或 `waiting_permission`。
3. UI 在 Decision Queue 展示决策目标、选项、风险、证据、相关 Artifact 和影响范围。
4. 用户提交 `decision.answer`、`permission.approve` 或 `permission.reject` Command。
5. Runtime 追加 Event，更新 Projection，并继续调度或阻塞运行。

### Flow-005：Workflow 长任务

1. 用户选择 Workflow 模板或让 Planner 生成 Workflow Profile。
2. Runtime 校验 Profile、nodes、depends_on、loop、verification、budget 和 authority。
3. Runtime 将 Workflow Profile 展开为 Harness Action Graph。
4. Workflow Runner 按 dependency、budget 和 gate 调度 nodes。
5. 每个 node 的结果写入 Artifact Index、Event、Projection 和 Trace。
6. 如果进程重启，Runtime 通过 Event、Materialized State、Snapshot 和 Manifest 重建状态。
7. Workflow 完成、阻塞、部分完成或失败时，UI 展示统一 canonical status。

### Flow-006：Agent 模板管理

1. 用户在 Agent Manager 创建或导入 Agent 模板。
2. 系统校验 id、name、description、persona、entry、capability、permission、model_preference、relationships 和 orchestration_policy。
3. 校验通过后模板进入 Agent Registry。
4. UI 展示 Agent 的可见入口、能力、成本、权限、模型偏好、启用状态和诊断信息。
5. Runtime 在 routing 时根据 capability、entry、authority、budget 和 availability 选择候选 Agent。

### Flow-007：Trace 导出和复盘

1. 用户在 Run Detail 或 Governance View 发起 `trace.export.request`。
2. Runtime 根据 visibility 和 redaction policy 选择 Event、Trace、Artifact summary、Decision 和 Gate evidence。
3. 系统生成可读导出材料，并保留结构化 refs。
4. 用户或后续 Agent Session 可以使用导出材料进行审查、评测或复盘。

### Flow-008：失败恢复

1. Runtime 检测到 Action、Assignment、Projection update、executor 或 adapter 失败。
2. 系统写入失败 Event，Projection 标记 failed、blocked、partial 或 stale。
3. Runtime 根据 Event Log、Materialized State、Artifact Index、Snapshot 和 Manifest 生成恢复候选。
4. 需要用户判断时创建 Decision。
5. 用户选择 retry、replan、handoff、abort 或 accept partial。
6. Runtime 写入 rehydration 事件，重建执行环境或 Agent Session context。

## 4. 用户可见状态

UI 统一展示 canonical status：

| 状态 | 用户理解 |
|---|---|
| `draft` | 已创建，尚未准备执行。 |
| `ready` | 已通过校验，可以调度。 |
| `running` | 正在执行。 |
| `waiting_user` | 等待用户输入。 |
| `waiting_permission` | 等待权限审批。 |
| `blocked` | 缺少前置条件或决策，无法继续。 |
| `partial` | 已有可用结果，但仍有必要子项、验证、handoff、Artifact 或 gate 未完成。 |
| `failed` | 执行失败。 |
| `completed` | 成功完成。 |
| `skipped` | 被记录的 Decision、Gate 或依赖规则跳过。 |
| `cancelled` | 完成前被取消。 |
| `aborted` | Run 被终止为最终状态。 |

## 5. 用户体验要求

- 用户应能从任意 Run 进入 Action Graph、Assignment、Agent Session、Artifact、Decision、Event 和 Trace。
- 用户应能区分模型声明、Runtime 接受、executor 执行和 UI 展示之间的关系。
- 用户应能进入 root、child 和 descendant Agent Session，并对具体 session 提交输入。
- 用户应能看到每个状态的来源证据，而不是只看到自然语言总结。
- 用户应能对高风险操作做审批，对失败任务做恢复选择。
- 用户应能导出可读且结构化的 Trace。

