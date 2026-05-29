# Workflow 持久编排 Adapter

## 目的

Workflow 是基于 Harness 基础 DSL 的 durable orchestration adapter。

它定义结构、约束、状态文件和结果协议，让 Orchestrator Agent 可以生成面向具体任务的 durable run，并让 Runtime 执行、恢复、审计和修复该 run。

该 adapter 使用 `docs/harness-protocol/00-harness-governance-protocol.md` 中的治理模型：Runtime 控制 validation、state transitions、scheduling、permissions、events、projections 和 gates。Workflow-specific 文件是更大 Harness run model 下的 adapter state。

同一格式同时支持：

- Planner / Orchestrator Agent 动态生成的 workflow
- 人类为可重复过程编写的 static workflow

## 设计原则

- Workflow DSL 描述 orchestration state，而不是 provider scheduling limits。
- Workflow file 是 run record，不只是 reusable template。
- Runtime 控制 validation、state transitions、scheduling 和 permissions。
- Planner 负责 workflow generation，以及执行无法确定继续时的后续 decision-making。
- Worker 只负责 node execution。
- Static workflow 和 generated workflow 在执行前都收敛到同一 durable run layout。
- 对 resume 有意义的每个 state change，都要在下一个 Action 开始前持久化。

## 术语

- **Template**：来自 package 或 user config 的可复用 workflow definition。
- **Run**：位于 `.opencode/harness/runs/<run>/workflow/` 下的物化 workflow instance。
- **Workflow file**：`workflow.json` run manifest 和 DAG。
- **Node file**：某个 DAG node 的 durable assignment、progress、result 和 error record。
- **Artifact**：任何通过路径引用、而不是嵌入 JSON 的较大输出。
- **Decision**：失败、阻塞或 replan request 之后，Planner / Decision Agent 给出的结构化 response。

## 何时生成 Workflow

Agent 默认不生成 workflow DSL。Workflow generation 保留给 orchestration entrypoints。

满足至少一个条件时生成 workflow：

- 任务有多个相互依赖阶段
- 任务有可以并行运行的独立子任务
- 执行需要多个 Agent 或新 session
- 执行必须跨 process restart 或 session interruption 存活
- failure handling 需要 retry、cancellation、added nodes 或 replanning
- 用户明确要求 orchestration、long-running task、可执行 plan 或 progress tracking

以下情况使用普通执行路径：

- single-turn answers
- simple code explanations
- small single-session edits
- a single command
- worker execution of an already assigned node

Worker Agent 不创建 workflow。它们执行一个已分配 node，并更新该 node 的 state file。如果 worker 无法完成 node，它报告结构化 status，例如 `blocked`、`failed` 或 `needs_replan`。

## Workflow Agent 类型

### Planner / Orchestrator

Planner 可以创建 initial workflow，并在 execution starts 前持久化。它定义 DAG、node goals、dependencies、node types、success criteria、input references 和 failure policies。

### Worker

Worker 精确执行一个 node assignment。它读取 node file 和引用输入，执行任务，写入 progress，并以结构化 result 结束。

Worker 不需要了解完整 workflow generation rules。它只需要 node state protocol。

### Decision Agent

Decision Agent 处理异常执行状态。第一版可以使用与 Planner 相同的 Agent template。Runtime 仍应通过 capability 和 authority 绑定它，让未来 Recovery Agent 可以替换它，而不改变 workflow DSL。

Decision Agent 可以选择一个有边界的 action：

- `retry_node`
- `skip_node`
- `cancel_branch`
- `add_node`
- `modify_node`
- `request_input`
- `replan_workflow`
- `abort_workflow`

## Workflow Runner Agent 契约

Workflow Runner 是理解并创建 durable workflow run records 的 adapter-specific Agent。它可以是 primary 和 delegable，但不应成为默认 general coding Agent，除非产品明确希望 workflow-first orchestration behavior。

推荐模板：

```json
{
  "id": "workflow-runner",
  "name": "Workflow Runner",
  "persona": "You are the Workflow Runner. You convert complex goals into durable workflow DAG runs, coordinate execution through the runtime, and make bounded decisions when execution is blocked.",
  "description": "Primary orchestration agent for durable workflow DAG generation, execution coordination, and recovery decisions.",
  "entry": {
    "primary": true,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "workflow_orchestration",
    "tags": ["workflow", "orchestration", "planning", "decision"],
    "cost": "high",
    "writes": true
  },
  "workflow_mode": "supervision",
  "permission_mode": "custom"
}
```

Workflow Runner 负责：

- 判断 request 是否需要 workflow mode
- 生成最小有用 workflow DAG
- 定义 global goal、assumptions、success criteria、node tasks、dependencies、input refs 和 failure policy
- 使用 `workflow.create`、`workflow.start`、`workflow.status`、`workflow.decide` 和 `workflow.abort`
- 作为 blocked、failed 或 `needs_replan` 状态的首个 Decision Agent
- 只通过 Runtime 校验过的 decisions 更新 run structure

Workflow Runner 不负责：

- 直接执行 worker nodes，除非 Runtime 分配给它
- 修改 worker-owned node progress
- 绕过 schema、permission、gate 或 state-machine validation
- 在 workflow DSL 中编码 provider/model concurrency
- 在 task execution 期间发明无关 workflow syntax

Workflow Runner prompt 规则：

- 只为 complex、multi-stage、parallel、multi-agent、resumable 或 failure-sensitive tasks 生成 workflow DSL。
- 不为 simple answers、small single-session edits、single commands 或 delegated worker nodes 生成 workflow DSL。
- 将 workflow DSL 视为 durable DAG DSL，而不是通用编程语言。
- 在 execution starts 前持久化 `workflow.json` 和 initial node files。
- 保持 initial DAG 小，只通过 validated decisions 后续增加 nodes。
- 将 node types 作为 routing hints，而不是固定 Agent ids。
- 除非 Runtime 明确将 node 分配给该 Agent，否则不要自行执行 worker nodes。
- 当执行失败或阻塞时，选择一个有边界的 decision action，并说明原因。

推荐 node type routing：

| Node type | Desired capability |
|---|---|
| `research` | source reading, docs, code search |
| `design` | architecture, API design, planning |
| `implementation` | code editing and focused implementation |
| `test` | command execution, test diagnosis |
| `review` | code review, correctness, regression risk |
| `gate` | deterministic validation, release or merge checks |
| `summary` | final synthesis and user-facing report |

Workflow Runner 可以请求某个 Agent，但 Runtime 必须基于 `entry.delegable`、`capability`、authority 和 permission policy 解析并校验。

## Runtime 责任

Runtime 是 enforcement layer。Agent rules 是 guidance；Runtime checks 是强约束。

Runtime 必须：

- execution 前校验 workflow files
- scheduling 任何 node 前持久化 workflow files
- 持久化每个 node state transition
- 基于 dependencies 调度 runnable DAG nodes
- 根据 provider、model 和 Agent pool limits 决定实际 parallelism
- 根据 node type 和 capability metadata 将 nodes 路由到合适 Agent
- 限制 Worker 只能更新被分配的 node files
- 限制 workflow mutation 只能通过 Planner / Decision roles
- 对 state files 使用 atomic writes
- 在可能时将 state changes 追加到 event log

Concurrency 不是 workflow DSL 的一部分。DAG 暴露哪些 nodes 可以一起运行；scheduler 决定实际运行多少。

## Loop Node

外层 workflow graph 保持 DAG。test-fix-retest、draft-review-revise、generate-evaluate-retry 和 reproduce-fix-verify 这类反馈循环表示为 `loop` node，而不是表示为返回早期 DAG node 的 edge。

`loop` node 是 composite node，在 node boundary 内重复 child steps。Node id 由 planner 按任务生成；`validate`、`stabilize` 或 `qa` 这样的名称只是示例，不是保留 DSL concept。

初始 feature development 通常属于标准 outer DAG node。由 feedback 引起的 repair、revision 或 retry work 属于 loop node 内部。这样全局 dependency graph 仍可分析，同时允许有边界的 runtime feedback。

Loop node 形态：

```json
{
  "id": "feedback_loop",
  "type": "loop",
  "depends_on": ["implement"],
  "loop": {
    "max_attempts": 5,
    "until": [{ "type": "variable", "name": "feedback_loop.test", "equals": "passed" }],
    "memory": {
      "include": ["node.goal", "attempts.summary", "steps.test.output", "artifacts.diff"],
      "summarize": { "when": "context_tokens > 24000" }
    },
    "steps": [
      {
        "id": "test",
        "type": "test",
        "session": "per_call",
        "prompt": "Run validation. Return exactly `passed` when it succeeds; otherwise return failure details."
      },
      {
        "id": "fix",
        "type": "debug",
        "session": "per_loop",
        "mutates": true,
        "context": { "include": ["steps.test.output", "attempts.previous.fix", "artifacts.diff"] },
        "prompt": "Fix the reported failures and summarize changed files."
      }
    ]
  }
}
```

Runtime 语义：

- 每次 loop execution 都在 parent run context 下创建 attempt records
- child step run keys 按 `parent.child` 作用域命名，例如 `feedback_loop.test`
- `until` 在 child steps 更新 variables 后，根据 parent run context 评估
- `max_attempts` 是硬 safety limit
- child agents 在独立 sessions 中运行，并带有自己的 persona prompts
- Runtime 从结构化 workflow state 和 artifacts 构建 scoped context snapshots；不盲目复制完整 parent conversation
- `per_call` 为每次 call 创建 fresh child session
- `per_loop` 在可能时，为 loop node 内该 child step 复用同一个 child session

Parent run context 是事实来源。Child Agent Sessions 接收选定状态，执行一个 child step，并返回结果合并回 parent context。

## Workflow Tool 契约

Workflow generation 必须使用 Runtime 自有 tool protocol。

Planner / Workflow Runner 不通过自由文本创建 workflow files，也不自行执行 workflow steps。它调用 Runtime 自有 tool，提交结构化 workflow definition。Runtime 负责 validation、persistence、scheduling、resume 和 progress reporting。

初始 tool surface：

- `workflow.create`：为当前用户请求提交 workflow DAG definition
- `workflow.start`：启动先前创建的 workflow run
- `workflow.status`：读取当前 workflow run 和 node status
- `workflow.decide`：执行阻塞时提交有边界的 recovery decision
- `workflow.abort`：取消 workflow run

`workflow.create` 应：

- 只接受 workflow adapter schema
- 在任何 execution starts 前校验 schema
- 分配或校验唯一 workflow id
- scheduling 任何 node 前持久化 workflow definition
- 创建或引用 per-node state records
- 返回结构化 status，包含 workflow id、run id、status、validation result 和 next action
- 默认返回 `status: "created"` 或 `status: "ready"`，而不是直接执行

`workflow.start` 应：

- 接受由 `workflow.create` 创建的 `run_id`
- 只在 workflow 已持久化且已校验后开始 scheduling
- 返回模型可见结构化 execution result
- 包含 workflow id、run id、status、completed nodes、active nodes、failed nodes、outputs、artifacts 和 pause/error reason

`workflow.start` 返回的 tool result 是交回模型的 handoff。模型应使用该 result 生成最终用户可见 response，或在 workflow paused/failed 时请求有边界的 decision。

因此，模型侧契约是：

- 判断是否值得进入 workflow mode
- 如果值得，使用 workflow DAG 精确调用一次 `workflow.create`
- 只有当用户要求执行工作时，才在 `workflow.create` 成功后调用 `workflow.start`
- 当用户只要求设计、计划、预览或保存 workflow 时，不调用 `workflow.start`
- 不把 workflow JSON 作为 assistant prose 输出
- 不在 workflow runtime 分配 execution 前调用 read/edit/bash/task tools 执行 workflow steps
- `workflow.start` 返回后，读取 tool result 并为用户总结 execution outcome
- 如果不值得进入 workflow mode，则继续普通 chat/tool behavior

程序侧契约是：

- 从 tool call 识别 workflow creation，而不是解析 assistant text
- 将 tool call result 作为 persistence 和 execution 的事实来源
- 在 `workflow.start` 后驱动 execution loop
- 将 terminal、paused 或 failed workflow execution status 作为 tool output 返回给模型
- 从 Runtime state 向 UI 暴露 progress，而不是从模型写出的 summary 中推断

## Planner 生成契约

当 Planner 生成 workflow 时，它必须：

- 使用上面的 generation criteria 判断 workflow mode 是否值得
- 用 workflow definition 调用 `workflow.create`
- 让 Runtime 创建唯一 run directory 或 durable run record
- 让 Runtime 写入 `workflow.json` 和 per-node state records
- 让 Runtime 校验 DAG ids、dependency references、cycles 和 node types
- 等待 tool result 后再假定 workflow 已存在
- 只有当 execution 应立即开始时才调用 `workflow.start`

Planner 必须包含足够 intent 供后续 recovery 使用：

- global goal
- assumptions
- success criteria
- per-node goal and task
- per-node success criteria
- dependency rationale when it is not obvious
- failure policy

Planner 应让 first DAG 尽量小。不应预先展开 speculative recovery branches。失败或缺失工作可以后续通过 Decision action 增加。

## Worker 执行契约

当 Worker 收到 node assignment 时，它必须：

- 读取 assigned node file
- 除非任务需要更多 context，只读取引用的 upstream node files 和 artifacts
- 在 assigned node file 中更新 progress
- 将 artifacts 写入 workflow run `artifacts/` 目录
- 以一个 terminal node status 或 decision-request status 结束

Worker 不能：

- 创建新 workflow
- 编辑 `workflow.json`
- 编辑另一个 node 的 file
- 改变 DAG dependencies
- 在 blocker 已使 node goal 失效后静默继续

如果 Worker 认为 plan 错误或不完整，应将 node 标记为 `needs_replan`，并在 `error` 或 `signals` 中解释原因。

## 持久化布局

使用固定 workflow root，但不使用固定 workflow instance directory。每个 workflow run 都获得唯一目录。

推荐 project-local layout：

```txt
.opencode/harness/runs/
  run_20260517_103012_a8f3/
    workflow/
      workflow.json
      lock
      events.jsonl
      nodes/
        research.json
        design.json
        implement.json
        test.json
      artifacts/
        research.md
        patch.diff
      decisions/
        failure_001.json
```

Run id 应包含 timestamp 和 random suffix，避免跨 session 冲突：

```txt
run_YYYYMMDD_HHMMSS_<random>
```

只要每个 workflow 有自己的目录，多个 session 就可以安全地在同一 root 下创建 workflow。对同一 workflow 的并发更新必须使用 lock 或 atomic file writes。

## Workflow 文件

`workflow.json` 是稳定 DAG definition 和 run manifest。它应引用 node files，而不是嵌入大型 progress 或 result payloads。

推荐顶层字段：

| Field | Required | Owner | Notes |
|---|---:|---|---|
| `id` | yes | runtime | 唯一 workflow run id。 |
| `schema` | yes | runtime | Integer schema version。 |
| `goal` | yes | Planner | 用户可见目标。 |
| `status` | yes | runtime | Workflow status enum。 |
| `created_at` | yes | runtime | ISO timestamp。 |
| `updated_at` | yes | runtime | ISO timestamp。 |
| `assumptions` | no | Planner | 对后续 decision 有用的 planning assumptions。 |
| `success_criteria` | yes | Planner | Global completion criteria。 |
| `nodes` | yes | Planner/runtime | DAG node references。 |
| `policies` | no | Planner/runtime | 默认 failure 和 blocking behavior。 |

示例：

```json
{
  "id": "wf_20260517_103012_a8f3",
  "schema": 1,
  "goal": "Fix SDK generation and verify the result.",
  "status": "running",
  "created_at": "2026-05-17T10:30:12Z",
  "updated_at": "2026-05-17T10:35:00Z",
  "assumptions": [
    "The JavaScript SDK is regenerated by packages/sdk/js/script/build.ts.",
    "Typecheck is the minimum verification gate."
  ],
  "success_criteria": [
    "The requested code change is implemented.",
    "The SDK is regenerated when API shapes changed.",
    "Relevant package typechecks pass."
  ],
  "nodes": [
    {
      "id": "research",
      "type": "research",
      "title": "Inspect SDK generation flow",
      "file": "nodes/research.json",
      "depends_on": []
    },
    {
      "id": "implement",
      "type": "implementation",
      "title": "Apply the code change",
      "file": "nodes/implement.json",
      "depends_on": ["research"]
    },
    {
      "id": "test",
      "type": "test",
      "title": "Verify the change",
      "file": "nodes/test.json",
      "depends_on": ["implement"]
    },
    {
      "id": "review",
      "type": "review",
      "title": "Review implementation and verification",
      "file": "nodes/review.json",
      "depends_on": ["test"]
    },
    {
      "id": "gate",
      "type": "gate",
      "title": "Accept workflow result",
      "file": "nodes/gate.json",
      "depends_on": ["review"]
    }
  ],
  "policies": {
    "on_node_failed": "ask_decision",
    "on_blocked": "ask_decision",
    "max_attempts": 2
  }
}
```

`workflow.json` 不包含 provider concurrency settings。

Workflow node references 应保持小：

| Field | Required | Notes |
|---|---:|---|
| `id` | yes | workflow 内唯一的稳定 node id。 |
| `type` | yes | 用于 routing 的 node type enum。 |
| `title` | yes | 短展示标题。 |
| `file` | yes | node file 的相对路径。 |
| `depends_on` | yes | 必须先完成的 node ids。 |
| `optional` | no | 如果该 node 被跳过，下游是否可以继续。 |

Runtime 必须拒绝 duplicate ids、missing dependency targets、self-dependencies 和 cycles。

## Node 类型

Node type 是 routing hint，不是 hard-coded Agent id。Runtime 使用 registry metadata，将 node type 加 task content 映射到 Agent candidate。

初始 node type enum：

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

Mapping 应可配置。例如，`implementation` 可以路由到 coding-capable Agent，而 `review` 可以路由到 review Agent。Workflow DSL 可以允许 optional requested Agent，但最终 Agent 仍由 Runtime 解析。

Routing precedence：

1. explicit node `agent.requested`，如果存在且允许
2. node type to capability mapping
3. agent registry `capability.tags` 和 `capability.purpose`
4. 当前 model/provider 的 default delegable Agent

只有当 Agent entry metadata 允许 delegation，且其 permission profile 能满足 node 的 expected writes 和 tools 时，该 Agent 才 eligible。

## 验证与 Gate

Implementation node 不应静默吸收 testing 和 review。DSL 应分两层表示 verification：

- node properties 定义 required acceptance 和 verification gates
- 专门的 `test`、`review` 或 `gate` nodes 执行这些 gates

这让 verification 可以被 scheduling、retry、audit 和 recovery。也让 Runtime 能区分：

- implementation completed but tests failed
- tests passed but review failed
- review passed but final gate needs a user or policy decision

推荐模式：

```txt
implement -> test -> review -> gate -> next
```

更大范围变更：

```txt
             -> unit_test
implement -> typecheck -> review -> gate -> next
             -> integration_test
```

Implementation node 示例：

```json
{
  "id": "implement",
  "type": "implementation",
  "title": "Apply the code change",
  "file": "nodes/implement.json",
  "depends_on": ["research"],
  "verification": {
    "required": true,
    "strategy": "separate_nodes",
    "must_pass": ["test", "review"],
    "commands": ["bun typecheck"],
    "notes": [
      "Add or update focused tests for changed behavior.",
      "Do not mark implementation accepted until test and review nodes pass."
    ]
  }
}
```

Test node 示例：

```json
{
  "id": "test",
  "type": "test",
  "title": "Verify changed behavior",
  "file": "nodes/test.json",
  "depends_on": ["implement"],
  "success_criteria": [
    "Focused tests for changed behavior pass.",
    "Typecheck passes from the relevant package directory."
  ]
}
```

Review node 示例：

```json
{
  "id": "review",
  "type": "review",
  "title": "Review implementation and tests",
  "file": "nodes/review.json",
  "depends_on": ["test"],
  "success_criteria": [
    "Implementation satisfies the workflow goal.",
    "Tests cover the critical behavior and failure paths.",
    "No unrelated refactors or regressions are introduced."
  ]
}
```

当多个 verification branches 必须汇合，或 downstream work 开始前需要 user/policy decision 时，Gate node 是可选但有用的。

Runtime 应将 `verification.must_pass` 视为 acceptance contract。即使某个 node 自身 execution status 是 `success`，如果其 required verification 未满足，也不能认为它已被 workflow completion 接受。

## Node 文件

每个 node file 既是 assignment，也是 durable execution record。

推荐字段：

| Field | Required | Owner | Notes |
|---|---:|---|---|
| `id` | yes | runtime | 必须匹配 workflow node id。 |
| `workflow_id` | yes | runtime | Parent workflow run id。 |
| `schema` | yes | runtime | Node schema version。 |
| `type` | yes | Planner | Node type enum。 |
| `status` | yes | runtime/Worker | Node status enum。 |
| `attempt` | yes | runtime | 从 0 或 1 开始，retry 时递增。 |
| `title` | yes | Planner | 短展示标题。 |
| `task` | yes | Planner | 给 Worker 的具体任务。 |
| `depends_on` | yes | Planner | 从 workflow 复制的 dependency ids，方便本地阅读。 |
| `agent` | no | runtime | Requested 和 resolved agent/session data。 |
| `input` | no | Planner/runtime | 引用的 node files 和 artifacts。 |
| `success_criteria` | yes | Planner | Node completion criteria。 |
| `verification` | no | Planner/runtime | 该 node output 所需 test/review/gate contract。 |
| `failure_policy` | no | Planner/runtime | Node-specific failure behavior。 |
| `progress` | no | Worker | 可变 progress summary。 |
| `result` | no | Worker | 结构化 success 或 partial result。 |
| `error` | no | Worker/runtime | 结构化 failure 或 blocker。 |
| `signals` | no | Worker | 给 Runtime 或 Decision Agent 的 hints。 |
| `artifacts` | no | Worker | Artifact references。 |
| `created_at` | yes | runtime | ISO timestamp。 |
| `started_at` | no | runtime | ISO timestamp。 |
| `updated_at` | yes | runtime/Worker | ISO timestamp。 |
| `finished_at` | no | runtime/Worker | ISO timestamp。 |

运行中示例：

```json
{
  "id": "implement",
  "workflow_id": "wf_20260517_103012_a8f3",
  "schema": 1,
  "type": "implementation",
  "status": "running",
  "attempt": 1,
  "title": "Apply the code change",
  "task": "Use the research node result to update SDK generation behavior.",
  "depends_on": ["research"],
  "agent": {
    "mode": "new_session",
    "requested": "implementation",
    "resolved": "codex-worker",
    "session_id": "sess_456"
  },
  "input": {
    "nodes": ["nodes/research.json"],
    "artifacts": []
  },
  "success_criteria": [
    "The implementation satisfies the workflow goal.",
    "Changed files are listed in the result."
  ],
  "verification": {
    "required": true,
    "strategy": "separate_nodes",
    "must_pass": ["test", "review"],
    "commands": ["bun typecheck"],
    "notes": [
      "Verification is executed by separate nodes, not swallowed by this implementation node."
    ]
  },
  "failure_policy": {
    "on_failure": "ask_decision",
    "max_attempts": 2,
    "retryable_errors": ["timeout", "rate_limit", "network"]
  },
  "progress": {
    "summary": "Located the generator and started updating output logic.",
    "steps": [
      {
        "title": "Read generator code",
        "status": "success"
      },
      {
        "title": "Patch output logic",
        "status": "running"
      }
    ]
  },
  "result": null,
  "error": null,
  "artifacts": [],
  "created_at": "2026-05-17T10:31:00Z",
  "started_at": "2026-05-17T10:32:00Z",
  "updated_at": "2026-05-17T10:34:00Z",
  "finished_at": null
}
```

成功结果示例：

```json
{
  "status": "success",
  "result": {
    "summary": "Updated the SDK generation flow.",
    "changed_files": [
      "packages/sdk/js/script/build.ts"
    ],
    "signals": {
      "needs_review": true,
      "needs_replan": false
    }
  },
  "error": null,
  "artifacts": [
    {
      "type": "patch",
      "path": "artifacts/implement.patch"
    }
  ]
}
```

失败结果示例：

```json
{
  "status": "failed",
  "result": null,
  "error": {
    "kind": "typecheck_failure",
    "message": "bun typecheck failed in packages/opencode.",
    "retryable": false,
    "details": "Generated SDK types no longer match the server schema."
  },
  "signals": {
    "needs_decision": true,
    "suggested_action": "add_node"
  }
}
```

## 状态模型

Workflow status：

- `created`
- `ready`
- `running`
- `success`
- `failed`
- `blocked`
- `cancelled`
- `needs_decision`
- `needs_replan`

Node status：

- `pending`
- `ready`
- `running`
- `success`
- `failed`
- `blocked`
- `skipped`
- `cancelled`
- `needs_decision`
- `needs_replan`

只有 dependencies 已到达 `success` 或允许的 terminal state 的 nodes，才可以变成 `ready`。

允许的 node transitions：

```txt
pending -> ready
ready -> running
running -> success
running -> failed
running -> blocked
running -> needs_decision
running -> needs_replan
failed -> ready
blocked -> ready
needs_decision -> ready
needs_replan -> ready
ready -> cancelled
pending -> cancelled
running -> cancelled
ready -> skipped
pending -> skipped
```

`failed`、`blocked`、`needs_decision` 和 `needs_replan` 不总是 terminal。它们会暂停受影响 downstream nodes 的 scheduling，直到 deterministic policy 或 Decision action 解决。

允许的 workflow transitions：

```txt
created -> ready
ready -> running
running -> success
running -> failed
running -> blocked
running -> needs_decision
running -> needs_replan
running -> cancelled
needs_decision -> running
needs_replan -> running
blocked -> running
failed -> running
```

Runtime 应拒绝 stale transitions。例如，如果 Runtime 已取消某 node，Worker 不能再写入 `success`。

## 失败处理

Runtime 应先应用 deterministic policy：

- 在 `max_attempts` 内 retry retryable errors
- 只有策略明确允许时才 skip nodes
- required dependency cancelled 或 failed 时取消 downstream nodes
- 在接受 upstream implementation nodes 前，将 failed `test`、`review` 或 `gate` nodes 路由给 Decision Agent
- 当任何 required `verification.must_pass` node 未成功时，阻塞 workflow completion

当 deterministic policy 无法决策时，Runtime 询问 Decision Agent。Decision Agent 读取：

- `workflow.json`
- failed node file
- related upstream node files
- relevant artifacts
- `events.jsonl`

然后它在 `decisions/` 下写入 decision file，并返回一个 bounded action。如果该 action 改变 DAG，Runtime 会在继续前校验并持久化更新后的 workflow。

Decision file 示例：

```json
{
  "id": "decision_001",
  "workflow_id": "wf_20260517_103012_a8f3",
  "node_id": "test",
  "created_at": "2026-05-17T10:42:00Z",
  "action": "add_node",
  "reason": "The test failed because generated SDK files were not refreshed after the implementation node.",
  "changes": {
    "nodes": [
      {
        "id": "regenerate_sdk",
        "type": "build",
        "title": "Regenerate JavaScript SDK",
        "file": "nodes/regenerate_sdk.json",
        "depends_on": ["implement"]
      }
    ],
    "replace_edges": [
      {
        "from": "implement",
        "to": "test",
        "with": ["regenerate_sdk", "test"]
      }
    ]
  }
}
```

Decision actions 必须在 mutation 前校验。无效 decisions 应让 workflow 停在 `needs_decision`，并附带 error event。

## 事件日志

`events.jsonl` 是 append-only。它不是事实来源，但能让 debugging、audit 和 replay 更容易。

推荐 event shape：

```json
{
  "time": "2026-05-17T10:35:00Z",
  "type": "node_status",
  "workflow_id": "wf_20260517_103012_a8f3",
  "node_id": "implement",
  "from": "ready",
  "to": "running",
  "actor": "runtime"
}
```

有用 event types：

- `workflow_created`
- `workflow_status`
- `node_created`
- `node_status`
- `node_progress`
- `artifact_written`
- `decision_requested`
- `decision_applied`
- `decision_rejected`
- `workflow_resumed`
- `workflow_cancelled`

## 持久化规则

所有 JSON writes 都应使用 atomic replacement：

1. 读取当前文件
2. 校验 expected version 或 `updated_at`
3. 将 next content 写入同目录下的 temporary file
4. 条件允许时 fsync
5. rename 覆盖 target file
6. 追加 event

每个 mutable file 都应包含 writer 写入前已检查的单调递增 `rev` 或 `updated_at` timestamp。冲突检测优先使用 `rev`。

推荐 ownership：

| File | Writers |
|---|---|
| `workflow.json` | runtime、Planner、Decision Agent through runtime validation |
| `nodes/<id>.json` | runtime 和 assigned Worker |
| `events.jsonl` | runtime |
| `decisions/*.json` | Runtime 校验 Decision Agent output 后写入 |
| `artifacts/*` | assigned Worker 或 runtime |

可用时，Worker 应通过 Runtime APIs 提交 node updates。早期本地实现可以直接写文件，但仍必须遵守 ownership 和 atomic write rules。

## 恢复规则

启动或 resume 时，Runtime 应：

1. 发现 workflow run directories
2. 加载并校验 `workflow.json`
3. 加载每个被引用 node file
4. 除非 owning session 仍然存活，否则将 stale `running` nodes 标记为 `blocked` 或 `needs_decision`
5. 从 DAG 重新计算 ready nodes
6. 只有当所有 state files 一致时才继续 scheduling

如果 `workflow.json` 引用了缺失 node file，workflow 应进入 `needs_decision`。如果存在未被引用的 node file，Runtime 应保留不动并记录 audit event。

## Schema 边界

Workflow DSL 应保持为 orchestration schema。第一版 DAG design 允许的 control flow：

- dependency edges
- optional nodes
- guard checks
- bounded retry policy
- Runtime 校验后的 Decision Agent mutations

更复杂行为应通过 Decision action 增加或修改 nodes 表示，而不是在 workflow DSL 中嵌入 script language。

## 静态 Workflow

Static workflow 使用同一 schema。它们可以位于 package 或 user config directories 下，但每次 run 在执行前仍应被复制或 materialized 到唯一 durable run directory。

Static definitions 是 templates。Runtime workflow directories 是 execution records。

## Adapter 目标形态

Workflow adapter target shape 是：

- 带显式 dependencies 的 DAG `nodes`
- workflow definition 与 per-node durable state files 分离
- 按 node type 和 Agent capability routing
- scheduler-owned concurrency policy
- Planner / Workflow Runner 作为首个 Decision-capable Agent
- checkpoint、permission 和 gate behavior 由 Runtime policies enforcement

## 实现计划

Workflow adapter 应分阶段落地，并保持 schema、Runtime、Agents 和 UI 之间的 ownership 清晰。

### 阶段 1：Durable DAG Schema

- 增加带 `nodes` 的 workflow run schema
- 增加 `nodes/<id>.json` node state schema
- 增加 `decisions/*.json` decision schema
- 增加 implementation nodes 的 verification schema
- 增加 status enums 和 transition validation
- 校验 duplicate ids、missing dependencies、cycles 和 invalid verification refs

验证：

- schema tests 覆盖 valid workflow、invalid node refs、cycles、duplicate ids、invalid transitions 和 invalid verification references
- parser tests 证明 non-DAG fixtures 会以清晰 schema errors 失败

### 阶段 2：Durable Run 物化

- 在 `.opencode/harness/runs/<run>/workflow` 下创建唯一 run directories
- 将 static templates materialize 到 run directories
- scheduling 前写入 `workflow.json` 和 initial node files
- 增加带 revision checks 的 atomic JSON write helper
- 追加基础 `events.jsonl` records

验证：

- tests 可以并发创建多个 workflow 且没有 path collision
- restart test 可以重新加载 materialized workflow 和 node files
- stale 或 missing node files 会让 workflow 进入 `needs_decision`

### 阶段 3：DAG Executor

- 从 DAG state 计算 ready nodes
- 通过 Runtime limits 调度 serial 和 parallel-ready nodes
- 更新 `ready`、`running` 和 terminal states 的 node files
- 当 required dependencies fail 时取消或暂停 downstream nodes
- 当 required test、review 或 gate nodes 未完成时阻止 completion
- 将 failed verification nodes 路由到 deterministic retry 或 Decision Agent handling

验证：

- integration tests 覆盖 linear DAG、parallel-ready nodes、downstream pause 和 verification gates
- scheduler tests 证明 workflow DSL 不控制 concurrency

### 阶段 4：Agent Routing

- 定义 node type to capability routing table
- 只在允许时解析 requested agents
- worker dispatch 要求 `entry.delegable`
- 使用 `capability.purpose`、`capability.tags` 和 `capability.writes` 作为 routing signals
- 在 node files 中记录 resolved agent 和 child session id

验证：

- routing tests 根据 capability 选择 implementation、research、review 和 test agents
- hidden 或 non-delegable agents 被拒绝
- permission mismatch 在 execution 前阻塞 dispatch

### 阶段 5：Planner 与 Worker 契约

- 增加 Planner rules，用于 workflow generation 和 required intent fields
- 要求会改变行为的 implementation nodes 包含 test/review/gate nodes，或说明为什么不需要 verification
- 增加 Worker rules，用于 node-only execution
- 增加 Worker result protocol，支持 `success`、`failed`、`blocked` 和 `needs_replan`
- 将 assigned node file paths 暴露给 worker sessions

验证：

- prompt snapshot tests 包含 Workflow Runner rules
- worker prompt snapshots 排除 workflow generation rules
- worker integration tests 只更新 assigned node file

### 阶段 6：Runtime Runner Dispatch

- 增加显式 runner discriminator，例如 `runner: "chat" | "workflow" | "protocol"`
- 将 `workflow-runner` 映射到 workflow runner
- 暴露 `workflow.create`、`workflow.start`、`workflow.status`、`workflow.decide` 和 `workflow.abort`
- 要求 Workflow Runner 对 workflow-worthy tasks 在 direct execution tools 前调用 `workflow.create`
- 将 workflow execution results 作为 `workflow.start` tool result 返回给模型
- Worker execution 仍使用 chat runner 加 node assignment prompt

验证：

- session tests 证明 runner selection
- workflow tool tests 证明 create 只 validation 和 persistence，默认不 start
- workflow tool tests 证明 start 会 scheduling execution 并返回模型可见 results
- worker invocation tests 证明 delegated workers 不接收 workflow generation rules

### 阶段 7：Decision Handling

- 在 unresolved `failed`、`blocked` 或 `needs_replan` 时触发 decision request
- 将 workflow、failed node、dependency nodes、artifacts 和 events 传给 Decision Agent
- 校验 bounded decision actions
- 应用 `retry_node`、`add_node`、`modify_node`、`request_input`、`replan_workflow` 和 `abort_workflow`
- 将 validated decisions 写入 `decisions/`

验证：

- retry test 递增 attempt，并将 node 返回 `ready`
- add-node test 更新 DAG，并 materialize 新 node file
- invalid decision 让 workflow 停在 `needs_decision`
- abort decision 取消 unscheduled downstream nodes

### 阶段 8：UI 与 API

- 暴露 workflow run/list/status endpoints
- 返回 node statuses、blockers、artifacts 和 decision-needed state
- 暴露 resume 和 abort APIs
- 从 Runtime state 展示 progress，而不是使用模型写出的 summaries

验证：

- route tests 覆盖 create、status、resume、abort 和 restarted runs
- UI tests 展示 node progress 和 decision-needed state

## 状态归属规则

Workflow durable state 位于 workflow run directory 下。Session state 可以持有 workflow run id 的 references，但 node status、decisions、artifacts 和 recovery records 属于 workflow adapter store。
