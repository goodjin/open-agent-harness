# 路由与委托策略

## 目的

本文定义 Harness 如何选择 executor，以及如何委托工作。

Routing 将归一化后的 `Action` 转换为可执行的 `Assignment` 或直接 executor invocation。Delegation 是一种 routing 结果，其 executor 是 Agent Session。

## 输入

Runtime routing 使用：

- action `operation`
- 请求的 `executor.type`
- 请求的 `executor.target`
- 所需 capability
- resource 读写范围
- side effects
- Agent `entry`
- Agent `capability`
- Agent `relationships`
- Agent `orchestration_policy`
- 生效 permission policy
- 可用性、成本和模型偏好
- 当前 run state 和 dependency state

## 多 Agent 适用条件

当任务形态能从分离的执行上下文中获益时，Runtime 应将工作路由给多个 Agent Session。

适用条件：

- **任务可分解**：工作可以拆成相对独立的子目标，且每个子目标都有清晰输入和验收标准。
- **上下文可隔离**：每个子任务可以在独立 Context Bundle 中运行，而不继承完整会话历史。
- **成本收益匹配**：并行 session 带来的质量、覆盖率、速度或风险降低，足以覆盖额外模型、工具和协调成本。
- **结果可聚合**：子任务结果可以通过 artifact、summary、evidence、status 和 unresolved issues 合并回 parent run。
- **治理边界清晰**：每个子任务都能获得清晰的 authority、contract、trace 和 handoff boundary。

高度耦合且依赖共享可变上下文的工作，更适合先由一个 Agent Session 完成，直到 Runtime 能定义可靠的 contract boundary。

## 候选过滤

候选过滤顺序：

1. 从 `executor.type` 选择 executor class。
2. 如果 `target` 是具体对象，加载该 executor，缺失则拒绝。
3. 如果 `target` 是 `auto`，根据 registry metadata 构建候选。
4. 拒绝 hidden 或 disabled Agent，除非 Runtime 拥有明确 system authority。
5. 对 Agent delegation，要求 `entry.delegable === true`。
6. 匹配 capability purpose 和 tags。
7. 拒绝 permission profile 无法满足 Action side effects 的候选。
8. 应用成本、可用性和模型约束。
9. 选择最少意外的候选，并记录该决策。

模型可以建议 executor。最终选择由 Runtime 控制。

## Assignment 绑定

当 Action 委托给 Agent 时，Runtime 创建 assignment：

```json
{
  "id": "assign_review_changes",
  "action_id": "review_changes",
  "agent_id": "technical_reviewer",
  "capabilities": ["code_review", "testing"],
  "authority": {
    "read": ["repo://current"],
    "write": [],
    "approve": ["task.review"]
  },
  "contract": {
    "goal": "Review the current patch for correctness and regression risk.",
    "input": "context_bundle",
    "constraints": ["read_only", "focus_on_changed_files"],
    "depends_on": ["artifact://diff/current"],
    "evidence": ["finding_refs", "test_refs"],
    "artifacts": ["review_report"],
    "budget": {
      "cost": "medium",
      "timeout_ms": 600000
    },
    "risks": ["missed_runtime_regression"],
    "unresolved": [],
    "output": "evaluation_result"
  }
}
```

模板级 metadata 本身不授予 authority。Runtime 根据 Action policy、run policy、用户审批和 gate requirements 推导 assignment authority。

## Child Session Trace

Agent delegation 必须产生可检查的 child records：

- parent run id
- parent action id
- child session id
- assigned agent id
- 生效 capability match
- 生效 authority
- contract summary
- input context refs
- result summary
- artifact refs
- unresolved issues
- failure/block reason

失败的 child work 不能从 parent action 中静默丢弃。Parent action 应根据 `failure` 进入 `failed`、`blocked` 或 `partial`。

## Handoff 契约

从一个 Agent 到另一个 Agent 的 handoff 通过 Runtime 表示：

```txt
Agent A -> action result / command -> Runtime -> assignment -> Agent B
```

Agent A 可以提出 next Action 或 handoff request。Runtime 校验该请求、创建 Assignment，并将工作分发给 Agent B。

Handoff 应保留 contract boundary，而不是依赖自由文本 transcript continuation。

Handoff 字段：

```json
{
  "goal": "Rework the failing timeout handling after review.",
  "source_session": "session_code_developer",
  "target": {
    "executor": "agent",
    "capability": "implementation"
  },
  "constraints": ["keep_public_api", "touch_auth_module_only"],
  "depends_on": ["artifact://review/findings"],
  "evidence": ["artifact://test/logs/auth_timeout"],
  "artifacts": ["artifact://patch/current"],
  "budget": {
    "cost": "medium",
    "timeout_ms": 900000
  },
  "risks": ["retry_loop_regression"],
  "unresolved": ["confirm whether timeout should be configurable"]
}
```

Runtime 使用该结构创建下一个 Assignment、构造目标 Context Bundle，并保持 session 之间的 trace continuity。

## Runtime Orchestration Policy 展开

Agent 模板可以声明 `orchestration_policy`。Runtime 在 Agent Session 执行前、执行中和进入终态后评估该策略，并在满足条件时创建额外 Action / Assignment。

该机制用于表达 Runtime 主动编排 Agent 的常见模式，例如：

```txt
user request accepted
  -> Runtime evaluates orchestration_policy.preflight
  -> requirements_clarifier assignment
  -> code_developer assignment
  -> Runtime evaluates orchestration_policy.on_completed
  -> code_test assignment
  -> technical_reviewer assignment
  -> parent action completed
```

Runtime 展开 `orchestration_policy` 时遵循以下规则：

1. 读取相关 Agent 模板中的 `orchestration_policy`，并根据触发点选择 `preflight`、`on_completed`、`on_failed`、`on_blocked`、`on_risk_detected`、`on_artifact_changed` 或 `on_conflict`。
2. 结合 user request、assignment result、Artifact、side effects、resource scope、run state、gate result 和已有 trace 评估 `when` 条件。
3. 对每个命中的编排项，构造标准 Contract；需要交给后续 Agent 或 human 时，构造 Handoff Contract。
4. 将编排项转换为新的 Action 或 Assignment，并进入正常 routing 流程。
5. 对目标 Agent 使用 `entry.delegable`、`capability`、permission profile、availability 和 budget 做候选过滤。
6. 可读取 Agent `relationships` 解释上游、下游、替代和冲突关系，但不能把 relationship 当成已授权调用。
7. 为后续 Assignment 独立推导 authority；后续 Agent 不继承来源 Agent 的权限。
8. 追加 orchestration / handoff 相关 Event，更新 Projection 和 Trace。
9. 根据 `required` 判断 parent action 是否必须等待该编排项完成。
10. 根据 `limits.max_depth`、`limits.max_parallel`、`limits.dedupe_key` 和历史 trace 防止重复触发、隐式循环和无限编排。

编排项的 `contract` 必须保留完整边界：

- `goal`
- `constraints`
- `depends_on`
- `evidence`
- `artifacts`
- `budget`
- `risks`
- `unresolved`

展开后的内部 Action 形态：

```json
{
  "id": "orchestrate_verify_implementation",
  "type": "action",
  "operation": "orchestrate",
  "origin": {
    "kind": "agent_orchestration_policy",
    "source_assignment_id": "assign_code_developer",
    "trigger": "on_completed",
    "policy_id": "verify_implementation"
  },
  "executor": {
    "type": "agent",
    "target": "auto",
    "capabilities": ["verification"]
  },
  "depends_on": ["assign_code_developer"],
  "result": {
    "return_to_model": "summary",
    "store_full": true
  }
}
```

展开后的 Assignment contract：

```json
{
  "id": "assign_code_test",
  "action_id": "orchestrate_verify_implementation",
  "agent_id": "code_test",
  "authority": {
    "read": ["repo://current", "artifact://current/patch"],
    "write": [],
    "approve": []
  },
  "contract": {
    "goal": "Verify the implementation result.",
    "constraints": ["use_changed_files", "run_relevant_checks"],
    "depends_on": ["artifact://current/patch"],
    "evidence": [],
    "artifacts": ["test_report"],
    "budget": {
      "cost": "medium",
      "timeout_ms": 600000
    },
    "risks": ["implementation_regression"],
    "unresolved": []
  }
}
```

自动编排失败时，Runtime 根据 `required` 和 `failure` 决定 parent action 状态：

- `required: true` 的编排项失败会使 parent action 进入 `blocked`、`failed` 或 `partial`。
- `required: false` 的编排项失败会记录 trace 和 warning，但不必阻塞 parent action 完成。
- 目标 Agent 不存在、不可 delegation、权限不满足或预算不足时，Runtime 应记录 orchestration blocked reason。

当编排链需要复杂条件分支、循环、并行 fan-out/fan-in 或跨 session 长时间恢复时，应由 Workflow Adapter 表达。

## Delegation Request 恢复

如果模型输出直接 task/delegation request，Runtime 只有在以下条件成立时才可以将其恢复为 Agent Action：

- target Agent 具体或可安全解析
- description 足够具体，可以形成 assignment
- scope 和 expected result 已知
- permissions 可以 enforcement

否则 Runtime 应返回协议违规，并要求结构化 Action。

## 协议能力

Routing 与 Delegation 策略覆盖以下能力：

- 使用 `entry`、`capability`、authority、budget 和 availability 做 `target: "auto"` Agent 选择。
- 为 Agent delegation 创建 Assignment、Contract 和 Agent Session。
- 记录 child session trace links、artifact refs、result summary、unresolved issues 和 failure reason。
- 对 hidden、disabled、non-delegable 或 permission-mismatched Agent 执行 gate enforcement。
- 将 Handoff Contract 交给后续 Agent Session 或 human owner。
- 将复杂条件分支、循环、fan-out/fan-in 和跨 session 长时间恢复交给 Workflow Adapter 表达。
