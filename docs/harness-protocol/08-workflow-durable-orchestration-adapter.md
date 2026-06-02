# Workflow 持久编排 Adapter

## 定位

Workflow 是基于 Harness 基础 DSL 的 durable orchestration adapter。它用面向编排场景的 Profile 描述长任务、多阶段任务、多 Agent 协作、可恢复执行、验证门禁和失败处理。

Workflow Profile 进入 Runtime 后，会被归一化为 Harness Action Graph、Action、Assignment、Contract、Artifact、Event、Projection 和 Trace。Runtime 使用同一套权限、预算、上下文、状态、审计和恢复模型执行 workflow。

Workflow 适合以下场景：

- 任务有多个相互依赖阶段。
- 子任务可以并行执行。
- 需要多个 Agent Session 分工。
- 执行需要跨 turn、跨 session 或进程重启恢复。
- 执行需要明确 progress、pause、resume、decision 和 audit。
- 失败处理涉及 retry、replan、gate、handoff 或 human decision。

简单问答、单次读取、单个命令、小范围单会话编辑可以直接使用 Agent Protocol DSL 的 `calls[]`。

## 与 Harness 基础 DSL 的关系

Workflow Profile 是 Harness DSL 的场景化表达。它把通用 Action Graph 中常见的 durable orchestration 结构固定下来，让 Planner、Runtime、UI 和后续 Agent Session 都能读取。

Profile 字段沿用总纲的统一字段。Workflow 可以增加 durable orchestration 所需的 `nodes`、`loop`、`verification` 和 `decision`，但 node 内的完成标准、失败处理、预算、可见性、Artifact 和 Handoff 仍使用 `criteria`、`failure`、`budget`、`visibility`、`artifacts` 和 `handoff`。

映射关系：

| Workflow Profile | Harness 基础对象 | 语义 |
|---|---|---|
| `workflow` | Run / Adapter record | 一次可恢复编排运行。 |
| `goal` | Goal Contract | 用户目标、约束和成功边界。 |
| `nodes[]` | Action Graph nodes | 可调度的工作单元。 |
| `depends_on` | Action Graph edges | 前置依赖和 fan-in / fan-out。 |
| `node.type` | Routing hint / capability | 帮助 Runtime 选择 executor。 |
| `node.task` | Action input / Assignment Contract | 给 executor 的具体任务。 |
| `criteria` | Success Criteria | Runtime、Gate、Reviewer 和 UI 判断完成的标准。 |
| `failure` | Failure Policy | retry、block、ask_user、handoff、abort 等失败处理。 |
| `verification` | Gate Policy / Verification Action | test、review、approval、release gate 的验收条件。 |
| `artifacts` | Artifact Contract / Artifact Index | 产物声明、索引和引用。 |
| `budget` | Budget Policy | 时间、成本、token、attempt 和并行度约束。 |
| `visibility` | Visibility Policy | 控制结果进入模型、用户、日志、Trace 和未来运行的方式。 |
| `loop` | Bounded repeated Action Graph | 在 node 边界内表达有限反馈循环。 |
| `decision` | Decision / Handoff Contract | 阻塞、失败和 replan 后的结构化选择。 |
| `status` | Canonical status | 投影到统一 run/action/assignment 状态词汇。 |

Runtime 接受 Workflow Profile 后执行以下步骤：

1. 校验 workflow shape、node id、dependency、cycle、gate、budget 和 authority。
2. 创建或更新 durable run record。
3. 将 nodes 展开为 Action Graph。
4. 将 node task 展开为 Action / Assignment Contract。
5. 根据 routing policy 选择 tool、Agent Session、Runtime service、human、pipeline 或 service executor。
6. 按 dependency、budget、resource lock 和 policy 调度 ready nodes。
7. 将结果写入 Artifact、Event、Projection 和 Trace。
8. 根据 failure、Gate 和 Decision 恢复或推进 run。

## Workflow Profile

顶层字段：

```json
{
  "id": "wf_auth_timeout",
  "title": "Fix auth timeout handling",
  "goal": {
    "summary": "Implement typed timeout error handling for auth refresh.",
    "constraints": ["keep_public_api", "touch_auth_module_only"],
    "criteria": [
      "Typed timeout error is returned by the refresh path.",
      "Focused tests cover success and timeout cases."
    ]
  },
  "budget": {
    "cost": "medium",
    "timeout_ms": 1800000,
    "max_parallel": 2
  },
  "failure": {
    "on_node_failed": "ask_decision",
    "max_attempts": 2
  },
  "nodes": [
    {
      "id": "inspect",
      "type": "research",
      "title": "Inspect auth refresh flow",
      "task": "Find the auth refresh timeout path and relevant tests.",
      "depends_on": [],
      "criteria": [
        "Relevant source files and tests are identified.",
        "The current timeout behavior is summarized with evidence."
      ],
      "artifacts": [
        { "name": "auth_research", "type": "research_note" }
      ]
    },
    {
      "id": "implement",
      "type": "implementation",
      "title": "Implement timeout handling",
      "task": "Apply the code change using the inspect result.",
      "depends_on": ["inspect"],
      "mutates": true,
      "criteria": [
        "Code implements typed timeout error behavior.",
        "Changed files are listed in the result."
      ],
      "verification": {
        "required": true,
        "must_pass": ["test", "review"]
      },
      "artifacts": [
        { "name": "patch", "type": "diff" }
      ]
    },
    {
      "id": "test",
      "type": "test",
      "title": "Verify timeout handling",
      "task": "Run focused tests and typecheck for the changed behavior.",
      "depends_on": ["implement"],
      "criteria": [
        "Focused tests pass.",
        "Relevant package typecheck passes."
      ],
      "artifacts": [
        { "name": "test_report", "type": "verification" }
      ]
    },
    {
      "id": "review",
      "type": "review",
      "title": "Review implementation",
      "task": "Review the patch for correctness, regressions and test coverage.",
      "depends_on": ["test"],
      "criteria": [
        "Findings include severity and evidence.",
        "Review decision is approve, request_rework or needs_info."
      ],
      "artifacts": [
        { "name": "review_report", "type": "review" }
      ]
    }
  ]
}
```

Profile 字段保持可读和可校验。大型输出进入 Artifact，node 之间通过 refs、summary、status 和 evidence 传递结果。

## Node 语义

Node 是 workflow profile 中的编排单元。Runtime 将每个 node 转换为一个或多个 Action，并在需要 Agent 执行时创建 Assignment。

Node 字段：

| 字段 | 含义 |
|---|---|
| `id` | workflow 内稳定 node id。 |
| `type` | routing hint，例如 research、implementation、test、review、gate、decision。 |
| `title` | UI 和 transcript 使用的短标题。 |
| `task` | 给 executor 的具体工作描述。 |
| `depends_on` | 前置 node ids。 |
| `capabilities` | routing 可用的能力标签。 |
| `agent` | 可选 executor request，最终由 Runtime 解析。 |
| `mutates` | 是否可能修改 workspace 或外部状态。 |
| `context` | 需要 Runtime 构造的 Context Bundle refs。 |
| `inputs` | 结构化输入或 upstream refs。 |
| `outputs` | 输出变量或 artifact refs。 |
| `criteria` | node 完成标准。 |
| `verification` | test、review、approval 或 gate 要求。 |
| `failure` | node 级失败处理。 |
| `budget` | node 级资源预算。 |
| `visibility` | node 结果可见性。 |
| `artifacts` | node 产物契约。 |
| `handoff` | node 完成后的下游交接契约。 |

Node type 是 routing signal。Runtime 使用 node type、task、capabilities、mutates、authority、budget 和 Agent registry 选择 executor。

Node type：

- `research`
- `planning`
- `design`
- `implementation`
- `debug`
- `test`
- `review`
- `gate`
- `documentation`
- `build`
- `release`
- `decision`
- `manual`
- `summary`
- `loop`

## Loop Profile

Workflow 的外层 graph 使用 DAG。需要 feedback 的场景用 bounded loop node 表达，例如 test-fix-retest、draft-review-revise、generate-evaluate-retry。

Loop node 示例：

```json
{
  "id": "stabilize",
  "type": "loop",
  "title": "Stabilize implementation",
  "depends_on": ["implement"],
  "loop": {
    "max_attempts": 3,
    "until": [
      { "type": "variable", "name": "stabilize.test", "equals": "passed" }
    ],
    "memory": {
      "include": ["node.goal", "attempts.summary", "artifacts.patch"]
    },
    "steps": [
      {
        "id": "test",
        "type": "test",
        "task": "Run focused verification. Return `passed` or failure details.",
        "outputs": { "stabilize.test": "$stabilize.test" }
      },
      {
        "id": "fix",
        "type": "debug",
        "mutates": true,
        "task": "Fix the reported failure and summarize changed files.",
        "context": {
          "include": ["steps.test.output", "attempts.previous.fix", "artifacts.patch"]
        }
      }
    ]
  }
}
```

Runtime 语义：

- `max_attempts` 是硬边界。
- `until` 根据 parent run variables 和 loop child outputs 判断。
- 每个 child step 归一化为 Action。
- child step 可以创建独立 Agent Session。
- loop attempt、child output、Artifact、failure 和 Decision 都写入 Trace。
- parent node 只在 loop 条件满足或 failure 得到处理后进入终态。

## Verification 与 Gate

Workflow 使用 Success Criteria、Verification 和 Gate 表达验收。

模式：

```txt
implement -> test -> review -> gate -> summary
```

含义：

- `implementation` node 负责产生改动或候选结果。
- `test` node 负责产生可引用验证证据。
- `review` node 负责评估正确性、回归风险和测试覆盖。
- `gate` node 负责聚合 verification、approval、budget、privacy 或 release 条件。
- `summary` node 负责生成用户可见结论或后续 handoff。

`verification.must_pass` 指向 test、review 或 gate node。Runtime 在计算 workflow completion 时读取这些 gate 结果，并把未满足的验证投影为 blocked、waiting_user、waiting_permission 或 failed。

Gate 可以由 deterministic tool、Runtime service、Agent Session 或 human executor 完成。

## Workflow Runner

Workflow Runner 是适合创建和维护 Workflow Profile 的 Agent 模板。它负责把复杂目标转换为最小有用 workflow，并在 run 阻塞或失败时提出有边界的 Decision。

Workflow Runner Agent 语义：

```json
{
  "id": "workflow_runner",
  "name": "Workflow Runner",
  "entry": {
    "primary": true,
    "delegable": false,
    "mentionable": true,
    "default": false
  },
  "capability": {
    "purpose": "workflow_orchestration",
    "tags": ["workflow", "orchestration", "planning", "decision"],
    "cost": "high",
    "writes": true
  },
  "inherit_permissions": false,
  "permission_mode": "custom"
}
```

Workflow Runner 产出：

- goal contract
- workflow nodes
- depends_on
- criteria
- failure
- verification / gate
- budget
- artifact expectations
- decision options

Worker Agent Session 接收具体 node Assignment。Worker 的上下文由 Runtime 构造，包含 node task、Contract、upstream Artifact refs、当前 Projection、预算、约束和验证要求。

## Adapter Tool Surface

Workflow Adapter 可以通过 Runtime 自有 toolCall carrier 暴露操作。工具名是产品/API 入口，语义仍归一化为 Harness Action。

Adapter 操作：

- `workflow.create`：提交 Workflow Profile，Runtime 校验并创建 durable run record。
- `workflow.start`：启动已创建 workflow run。
- `workflow.status`：读取 workflow Projection 和 Trace summary。
- `workflow.decide`：提交 retry、skip、add_node、modify_node、request_input、abort 等 Decision。
- `workflow.pause`：暂停 run。
- `workflow.resume`：恢复 run。
- `workflow.abort`：终止 run。

这些操作都产生 Command 或 Action，再由 Runtime 写入 Event、Projection 和 Trace。

## Durable State

Workflow 的 durable state 是 adapter materialized state。它服务调度、恢复和 UI 展示，并投影到统一 Harness run state。

Durable state 关系：

```txt
run
  workflow profile
  action graph
  node run records
  assignment records
  artifact index
  decision records
  event log
  trace index
  projection summary
```

Node run record 字段：

```json
{
  "id": "implement",
  "run_id": "run_auth_timeout",
  "action_id": "action_implement",
  "assignment_id": "assign_implement",
  "status": "running",
  "attempt": 1,
  "agent_session": "session_code_developer",
  "started_at": "2026-06-01T10:00:00Z",
  "updated_at": "2026-06-01T10:08:00Z",
  "inputs": ["artifact://run_auth_timeout/auth_research"],
  "outputs": [],
  "artifacts": [],
  "error": null
}
```

Workflow status 使用 Harness canonical status：

- `draft`
- `pending`
- `ready`
- `running`
- `waiting_user`
- `waiting_permission`
- `blocked`
- `partial`
- `failed`
- `completed`
- `skipped`
- `cancelled`
- `aborted`

Node status 使用 Action / Assignment status：

- `pending`
- `ready`
- `running`
- `waiting_user`
- `waiting_permission`
- `blocked`
- `partial`
- `failed`
- `completed`
- `skipped`
- `cancelled`

## 执行语义

Runtime 执行 workflow 时遵循以下语义：

1. `workflow.create` 接受 Profile，创建 run、Action Graph 和 initial Projection。
2. Runtime 校验 duplicate id、missing dependency、cycle、authority、budget、gate 和 Artifact Contract。
3. `workflow.start` 将 run 从 `ready` 推进到 `running`。
4. Runtime 计算 ready nodes，并按 policy 调度。
5. 每个 node 转换为 Action；需要 Agent 时创建 Assignment 和 Agent Session。
6. Executor 结果写入 Action result、Artifact、Event 和 Trace。
7. Runtime 根据 result、criteria、verification 和 failure 更新 node status。
8. 所有 required nodes 和 gates 完成后，workflow run 进入 `completed`。
9. 阻塞、审批、失败和 replan 进入 Decision 或 Handoff 流程。

并行度由 Runtime 依据 ready nodes、resource lock、budget、provider/model limit、workspace safety 和 UI policy 决定。

## Failure、Decision 与 Handoff

Failure Policy 控制失败后的默认路径：

- `retry`：在 attempt budget 内重新执行 node。
- `block`：保持 run blocked，并生成 Decision request。
- `ask_user`：创建 human decision。
- `handoff`：把失败上下文交给恢复、调试或 review Agent Session。
- `abort`：终止 run。

Decision 结构：

```json
{
  "id": "decision_retry_test",
  "run_id": "run_auth_timeout",
  "source": "node:test",
  "action": "retry",
  "reason": "The test failed because the fixture was stale after the implementation.",
  "evidence": ["artifact://run_auth_timeout/test_report"],
  "changes": {
    "target": "node:test",
    "attempt_budget": 1
  }
}
```

Handoff 结构：

```json
{
  "goal": "Fix the review finding about timeout error propagation.",
  "source_session": "session_technical_reviewer",
  "target": {
    "executor": "agent",
    "capability": "implementation"
  },
  "constraints": ["keep_public_api", "touch_auth_module_only"],
  "depends_on": ["artifact://run_auth_timeout/review_report"],
  "evidence": ["artifact://run_auth_timeout/test_report"],
  "artifacts": ["artifact://run_auth_timeout/patch"],
  "budget": {
    "cost": "medium",
    "timeout_ms": 900000
  },
  "risks": ["auth regression"],
  "unresolved": ["confirm whether timeout duration should be configurable"]
}
```

Runtime 将 Decision 和 Handoff 都转换为受治理的 Action / Assignment，并记录 Event、Projection 和 Trace。

## Recovery 与 Rehydration

Workflow 恢复使用统一状态模型：

- Event Log 确定 Runtime 接受过的事实。
- Projection 判断 run 当前状态和可调度节点。
- Materialized State 提供 workflow、node、assignment、decision 和 artifact 当前状态。
- Snapshot 记录 workspace、artifact index 或 executor checkpoint。
- Manifest 重建 executor 可见环境。
- Trace 解释恢复前后的证据链。

恢复流程：

1. 加载 workflow run record、Action Graph、node run records 和 Artifact Index。
2. 从 Event sequence 重建 Projection。
3. 检查 running Assignment 对应的 Agent Session 或 executor invocation。
4. 将可恢复的 executor 通过 Manifest 和 Snapshot rehydrate。
5. 将缺少 owner 的 running node 投影为 `blocked`，并创建 Decision request。
6. 重新计算 ready nodes。
7. 继续调度或等待用户、权限、Decision。

## UI 与 Agent 可读产物

Workflow Projection、Trace、Artifact summary 和 node records 面向人类和 Agent Session 可读。

UI 展示：

- workflow title、goal、status 和 progress
- node DAG 和依赖关系
- running / blocked / failed nodes
- pending decision 和 approval
- Artifact index
- child Agent Session trace
- budget 和 gate 状态
- recovery / replay / export 入口

Agent Session 接收：

- node task
- Contract
- upstream Artifact refs
- criteria
- failure
- budget
- visibility
- current Projection summary
- relevant Trace summary

Runtime 通过结构化 refs 连接 UI、Trace、Artifact 和 Agent Context，避免系统产物只适合人读。

## Static Workflow

Static workflow 是可复用 Workflow Profile template。Runtime 每次执行前将 template materialize 为新的 run record，并生成独立 Action Graph、Projection、Trace 和 Artifact Index。

Static workflow 适合 release gate、常规 evaluation、固定 review 流程和长期监控。它与动态生成 workflow 使用同一 adapter 语义。
