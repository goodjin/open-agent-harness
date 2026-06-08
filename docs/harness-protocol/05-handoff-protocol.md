# Handoff 协议

状态：Draft

日期：2026-06-02

相关文档：

- `02-model-runtime-protocol.md`
- `04-routing-and-delegation-policy.md`
- `06-state-event-projection-model.md`
- `07-context-memory-visibility-policy.md`
- `09-ui-console-and-agent-management.md`

## 目标

Handoff 协议定义一个 Agent Session 如何把可继续使用的工作状态交给另一个 Agent Session、human owner 或 Action Graph node。

它处理的是一个执行问题：下一个 executor 要看懂上一个会话做了什么、留下了什么、哪里有风险、下一步该从哪里接，同时不默认读取完整且嘈杂的 transcript。

完整 transcript 里可能包含重复工具输出、失败尝试、用户中途修正、过期假设和无关日志。短总结又可能漏掉关键现场。Handoff 因此使用四类输入：

- `raw records`：保存现场原文。
- `structured trace`：建立过程索引。
- `source Agent self-report`：提供现场语义线索。
- `handoff_writer output`：压缩成下一个会话能读的交接草稿。

最终 Handoff record 由 Runtime 生成和持有。模型可以起草、压缩和解释；Runtime 负责记录原始材料、校验引用、执行 visibility/redaction、写入 Event，并为目标会话构造 Context Bundle。

本文档沿用 Handoff 协议这个名称，但它实际覆盖跨 Session 协作通信。协议层只保留三类通信原语：`assign`、`handoff` 和 `sync`。复杂流程，例如开发、审查、返工和再审，由 Runtime 用这三类原语组合成 gate、loop 和 policy。

## 通信原语

| 原语 | 核心语义 | 是否创建任务 | 是否转移执行权 | Runtime 主动作 |
|---|---|---:|---:|---|
| `assign` | 分派一个新的工作单元 | 是 | 否，创建新的 owner | 创建 assignment、选择 target、构造初始 Context Bundle |
| `handoff` | 将当前工作交给另一个会话继续 | 否，延续已有任务 | 是 | 收集 source state、生成接力上下文、切换 owner |
| `sync` | 同步状态、结果、阻塞或审查意见 | 否 | 否 | 更新 Projection、gate、assignment 状态或通知目标 |

### assign

`assign` 面向“接下来要做什么”。它用于分派开发、审查、测试、验证、调研、返工等新工作单元。

典型场景：

- 父 Agent 分派子任务。
- Runtime 根据 Action Graph 创建下一步 assignment。
- 开发完成后，Runtime 创建 review 或 test assignment。
- review 失败后，Runtime 创建 repair assignment。
- 用户在 UI 或会话中提出“交给 review agent 看一下”，Runtime 将这个意图转成 review assignment。

`assign` 的内容应像任务合同，而不是会话总结：

```json
{
  "kind": "assign",
  "purpose": "execute | review | verify | repair | investigate",
  "source": {
    "session_id": "parent_session",
    "agent": "orchestrator"
  },
  "target": {
    "agent": "reviewer"
  },
  "task": {
    "goal": "Review the session management tools implementation.",
    "scope": ["packages/opencode/src/session/runtime-tools.ts"],
    "inputs": ["artifact://patch/session_tools", "sync://developer/completed"],
    "constraints": ["Do not modify files during review."],
    "criteria": ["Findings must include file and evidence refs."]
  },
  "return": {
    "mode": "structured",
    "expected": "findings_first"
  }
}
```

Runtime 处理：

- 校验 target agent、权限、scope、budget 和 visibility。
- 创建 assignment record。
- 创建或选择 child session。
- 构造初始 Context Bundle。
- 写入 pending assignment / delegation。
- 记录 result policy、criteria 和 gate。
- 启动 target session，等待其通过 `sync` 返回状态。

### handoff

`handoff` 面向“同一个任务换谁继续”。它不是创建新任务，而是转移当前任务的执行权。

典型场景：

- 当前 Agent 做了一部分，另一个 Agent 继续做。
- 当前 Agent 能力不匹配，需要转给更合适的 Agent。
- context 或预算接近边界，需要新 Session 接续。
- 用户手动切换执行 Agent。
- Runtime 恢复后需要把当前任务交给新的 Session 继续。

`handoff` 比 `assign` 更关注现场状态：

```json
{
  "kind": "handoff",
  "reason": "agent_switch | capability_gap | context_limit | recovery | manual",
  "source": {
    "session_id": "source_session",
    "agent": "developer"
  },
  "target": {
    "agent": "reviewer"
  },
  "state": {
    "goal": "Continue refining the handoff protocol.",
    "done": ["Communication primitives were reduced to assign, handoff and sync."],
    "current": "Content generation responsibility still needs to be documented.",
    "next": ["Update the protocol document."],
    "constraints": ["Keep the protocol flat."],
    "risks": ["Do not treat user trigger text as generated communication content."]
  },
  "refs": ["trace://run/current", "artifact://doc/handoff_protocol"]
}
```

Runtime 处理：

- 确认 source task 不是终止状态。
- 收集 source raw refs、structured trace、artifact refs 和 accepted events。
- 在需要时请求 source Agent 生成 self-report。
- 调用 handoff_writer 合成可接续状态。
- 生成 canonical handoff record。
- 构造 target Context Bundle。
- 标记 source assignment 为 `handoffed` 或 `partial_handoff`。
- 将任务 owner 切换到 target session。
- 通过 dedupe key 和 action status 避免 target 重复执行已完成动作。

### sync

`sync` 面向“状态已经变化，需要同步”。它覆盖结果回复、进度更新、阻塞、失败、review findings、test report 和普通背景同步。

典型场景：

- 子 Agent 完成任务，把结果回给父 Agent。
- 子 Agent 汇报阶段性进度。
- 子 Agent 阻塞，需要父 Agent、Runtime 或用户决策。
- review Agent 返回 findings。
- test Agent 返回测试结果。
- Runtime 推送状态变化。
- 一个 Agent 给另一个 Agent 同步背景，但不转移执行权。

`sync` 用 `status` 和 `next` 表达差异：

```json
{
  "kind": "sync",
  "status": "info | progress | completed | partial | blocked | failed | reviewed",
  "source": {
    "session_id": "child_session",
    "agent": "reviewer"
  },
  "target": {
    "session_id": "parent_session",
    "agent": "orchestrator"
  },
  "subject": "Session management tools implementation",
  "summary": "Review found one permission boundary issue.",
  "details": [],
  "evidence": [],
  "needs": [],
  "next": {
    "owner": "runtime | parent | source | target | user | none",
    "action": "continue | decide | repair | review | accept | ignore"
  }
}
```

Runtime 处理：

| `sync.status` | Runtime 动作 |
|---|---|
| `info` | 追加 context note 或 memory candidate |
| `progress` | 更新 assignment progress |
| `completed` | 标记 assignment completed，通知 parent |
| `partial` | 记录 partial result，按 policy 决定继续、接收或升级 |
| `blocked` | 标记 blocked，请求 decision |
| `failed` | 标记 failed，执行 failure policy |
| `reviewed` | 更新 review gate，按 findings 决定 accept 或 repair |

`sync.next.action` 可以触发后续 Runtime 行为：

| `next.action` | Runtime 动作 |
|---|---|
| `accept` | 关闭 assignment 或 gate |
| `repair` | 创建 `assign.purpose = repair` |
| `review` | 创建 `assign.purpose = review` |
| `decide` | 向 parent 或 user 请求决策 |
| `continue` | 唤醒指定 owner 继续 |
| `ignore` | 仅保存和投影，不触发执行 |

## 父子会话通知与结果回收

父会话和子会话之间不直接通信。父会话要通知子会话时，只能表达通信意图；Runtime 负责校验权限、选择目标、构造 Context Bundle，并通过受控 Runtime 工具或内部 command 把通知送到目标子会话。

这个动作仍然使用 `sync` 语义。它不是新的通信原语。

父到子的通知形态：

```json
{
  "kind": "sync",
  "status": "info | progress | blocked",
  "source": {
    "session_id": "parent_session",
    "agent": "orchestrator"
  },
  "target": {
    "session_id": "child_session",
    "agent": "developer"
  },
  "subject": "Runtime protocol document update",
  "summary": "Parent session added a new lifecycle constraint. Re-check your current task against the updated criteria.",
  "details": [],
  "evidence": ["projection://run/run_123/lifecycle"],
  "needs": [],
  "next": {
    "owner": "target",
    "action": "continue"
  }
}
```

Runtime 处理：

- 校验 parent session 是否有权通知目标 child session。
- 判断通知是否会改变 child Assignment 的目标、scope、criteria、budget 或 context。
- 如果通知只同步背景，写入 child context note，并让 child 在下一轮模型调用中看到。
- 如果通知改变任务合同，写入 assignment update、Event、Projection，并让 child 明确看到更新后的 contract。
- 如果 child 当前 `running`，Runtime 不强行打断；通知进入 pending inbox，下一次安全点注入。
- 如果 child 当前 `idle`、`ready`、`waiting_user`、`waiting_permission` 或 `blocked`，Runtime 可以按 policy 唤醒或更新等待原因。

Runtime 应主动回复父会话。父会话发出通知后，不应只能看到“工具调用成功”。Runtime response 应说明通知是否送达、目标会话当前状态、通知是否立即生效，以及下一步怎么回收结果。

父会话可见回复形态：

```json
{
  "type": "runtime.parent_reply",
  "status": "accepted",
  "summary": "Notification queued for 2 child sessions. One child is running and will receive it at the next safe point; one child is idle and has been resumed.",
  "targets": [
    {
      "session_id": "child_a",
      "status": "running",
      "delivery": "queued",
      "reason": "Child has an active model/tool attempt."
    },
    {
      "session_id": "child_b",
      "status": "idle",
      "delivery": "delivered",
      "reason": "Child was idle and could receive the context update."
    }
  ],
  "collection": {
    "id": "collect_child_results_001",
    "targets": ["child_a", "child_b"],
    "timeout_ms": 300000,
    "on_timeout": "inspect_status_and_summarize"
  }
}
```

### 多子会话结果回收

当父会话通知多个子会话，或等待多个子会话结果时，Runtime 应创建 result collection。collection 是 Runtime 的 fan-in 控制对象，用来汇总子会话结果、状态和未决事项。

Collection record 形态：

```json
{
  "id": "collect_child_results_001",
  "run_id": "run_123",
  "parent_session_id": "parent_session",
  "targets": [
    {
      "session_id": "child_a",
      "assignment_id": "assign_a",
      "required": true
    },
    {
      "session_id": "child_b",
      "assignment_id": "assign_b",
      "required": false
    }
  ],
  "timeout_ms": 300000,
  "started_at": "2026-06-07T10:00:00Z",
  "status": "collecting",
  "result_policy": {
    "reply_mode": "aggregate",
    "include_partial": true,
    "on_timeout": "inspect_status_and_summarize"
  }
}
```

Collection 汇总回复应包含：

- 已完成子会话的 ResultRecord、Artifact refs、criteria 和 risks。
- partial 子会话的可用结果和 unresolved。
- blocked 子会话的 blocked reason 和 needs。
- failed 子会话的 error、retryable 和 evidence。
- interrupted 子会话的 last safe point 和 recovery suggestion。
- running / idle / waiting 子会话的当前状态和 Runtime 建议。

超时不等于失败。timeout 只表示 collection 到达等待上限。Runtime 到达 timeout 后，应读取每个目标 child session 的当前 Projection，再给父会话一个状态汇总。

Timeout 汇总形态：

```json
{
  "type": "runtime.parent_reply",
  "status": "timeout_summary",
  "summary": "Collection timed out after 300000 ms. One child completed, one child is still running, and one child is blocked on permission.",
  "completed": [
    {
      "session_id": "child_a",
      "result": "result://session/child_a"
    }
  ],
  "still_running": [
    {
      "session_id": "child_b",
      "status": "running",
      "current": "Running focused tests.",
      "last_update": "2026-06-07T10:04:10Z"
    }
  ],
  "blocked": [
    {
      "session_id": "child_c",
      "status": "waiting_permission",
      "blocked_reason": "Needs approval to run browser verification."
    }
  ],
  "next": {
    "owner": "parent",
    "action": "decide",
    "options": ["wait_more", "continue_with_partial", "cancel_remaining", "request_permission"]
  }
}
```

Runtime 不应在 timeout 时自动把 still-running child 标记为 failed。只有 child executor 明确失败、failure policy 耗尽，或 owner 做出取消 / abort 决策后，才进入 failed、cancelled 或 aborted 路径。

## 内容生成责任

需要区分触发者和内容生成者。用户说“交给 review agent 看一下”只是触发意图，不会直接生成 review assignment 的完整通信内容。

Runtime 的职责是判断通信事件是否成立、收集事实、选择内容生成器、校验结果、更新状态和渲染上下文。具体语义内容应由最了解该内容的一方生成，再由 Runtime 归一化。

| 原语 | 语义内容主要来源 | Runtime 补充内容 | 可选 writer |
|---|---|---|---|
| `assign` | parent Agent 或 assignment_builder 生成 goal、scope、criteria、expected output | target routing、权限、budget、artifact refs、gate policy | assignment_builder |
| `handoff` | source Agent self-report 生成 done、current、next、risks | accepted events、trace、artifact refs、raw refs、dedupe | handoff_writer |
| `sync` | 产生状态的一方生成 summary、details、findings、blocked reason | status projection、evidence refs、gate update、next owner/action | sync_normalizer |

### assignment_builder

`assignment_builder` 负责把用户意图、父任务目标和 Runtime facts 合成为可执行任务合同。它不直接执行任务。

输入示例：

```json
{
  "user_intent": "交给 review agent 看一下",
  "parent_goal": "Implement session management tools for orchestration agents.",
  "source_state": "Developer sync completed.",
  "artifacts": ["artifact://patch/session_tools"],
  "gate_policy": {
    "type": "review",
    "on_fail": "assign_repair"
  },
  "target_agent": "reviewer"
}
```

输出进入 `assign.payload.task`：

```json
{
  "goal": "Review the session management tools implementation.",
  "scope": ["packages/opencode/src/session/runtime-tools.ts"],
  "inputs": ["artifact://patch/session_tools", "sync://developer/completed"],
  "constraints": ["Do not edit files during review."],
  "criteria": ["Return findings first with evidence refs."]
}
```

### handoff_writer

`handoff_writer` 负责把 source self-report、Runtime trace 和 artifact refs 合成接力上下文。source Agent 提供现场判断，Runtime 提供已接受事实，handoff_writer 负责压缩、排序和去噪。

handoff_writer 不获得执行用户任务的 authority。它输出的是交接材料，不是新的执行结果。

### sync_normalizer

`sync_normalizer` 负责把执行结果、阻塞说明、review findings 或测试结果归一化为 `sync` record。它可以是 Runtime reducer，也可以是 hidden writer。

例如 review Agent 生成 findings，Runtime 不应替它编造问题；Runtime 只负责补充 changed files、artifact refs、gate state，并决定是否创建 repair assignment。

## Review / Repair Loop

开发、审查、返工、再审是一种 Runtime 编排模式，不是新的通信原语。

```txt
assign(purpose=execute) -> developer
sync(status=completed) <- developer
assign(purpose=review) -> reviewer
sync(status=reviewed) <- reviewer
if findings:
  assign(purpose=repair) -> developer
  sync(status=completed) <- developer
  assign(purpose=review) -> reviewer
else:
  gate passed
```

Runtime 维护 loop state：

```json
{
  "loop": {
    "type": "review_repair",
    "iteration": 2,
    "max_iterations": 3,
    "origin_assignment_id": "assign_dev_01",
    "last_review_id": "assign_review_02",
    "state": "needs_repair | reviewing | accepted | failed"
  }
}
```

review assignment 的内容由 assignment_builder 根据用户意图、developer sync、changed files、test output 和 gate policy 生成。review findings 由 review Agent 生成，再由 Runtime 归一化为 `sync.status = reviewed`。如果 findings 需要修复，Runtime 创建 `assign.purpose = repair`，目标通常是原 developer 或当前 owner。

## Semantic Note

Runtime 应为目标 Context Bundle 增加一段简短语义说明，告诉模型如何消费这条通信。

`assign` 示例：

```md
Runtime note:
This is an assign record. You are responsible for the task described below until you report progress or final status with sync semantics.
```

`handoff` 示例：

```md
Runtime note:
This is a handoff record. Continue the existing task. Treat Done as history, Current as the latest stable state, and Next as the immediate work queue.
```

`sync` 示例：

```md
Runtime note:
This is a sync record. It updates state only. Do not assume ownership transfer unless next.action asks you to continue or repair.
```

## 核心流程

```txt
assign:
  user / parent intent
  -> Runtime gathers projection, trace and artifact refs
  -> assignment_builder creates task contract when needed
  -> Runtime validates, creates assignment and starts target session
  -> target later reports with sync

handoff:
  Runtime detects ownership transfer boundary
  -> Runtime requests source Agent self-report when needed
  -> Runtime builds Handoff Source Bundle
  -> handoff_writer compresses source bundle
  -> Runtime validates canonical handoff record
  -> target Context Bundle receives Handoff Markdown

sync:
  source Agent / Runtime produces status update
  -> Runtime normalizes status, evidence and next action
  -> Runtime updates Projection, gate or assignment state
  -> Runtime notifies or resumes target when policy requires
```

通信事件的触发权在 Runtime。Agent 或用户可以提出 intent，但 intent 只是输入，不等于正式通信 record。Runtime 需要根据 run state、assignment state、policy、用户操作和上下文预算决定创建 `assign`、`handoff` 还是 `sync`。

Runtime 在这些场景计划通信事件：

- **Assignment 终态**：Assignment `completed`、`partial`、`blocked`、`failed`，或执行被取消但已有可用现场。
- **下游依赖存在**：当前 Assignment 有 `next`、review、test、merge、follow-up、fan-in 聚合或其他 depends。
- **模型提出 intent**：source Agent 在协议输出里声明需要交给 reviewer、tester、human owner 或另一个 capability。
- **Orchestration Policy 命中**：例如 implementation 结束后进入 code review，review 结束后进入 test audit。
- **用户或 UI 手动触发**：用户指定“交给下一个 Agent”、“让 human 看一下”或从 Console 创建 continuation。
- **Runtime 限制触发**：context budget 接近耗尽、预算不足、权限不足、工具不可用或当前 executor 无法继续。
- **final continuation**：final answer 后需要为 future run 留下可恢复的工作状态。

Runtime 的计划结果应包含通信原语：

```json
{
  "type": "communication.plan",
  "kind": "assign | handoff | sync",
  "trigger": true,
  "reasons": ["assignment_terminal", "downstream_next"],
  "request_self_report": true,
  "status": "completed"
}
```

Agent 可以在协议输出里提出通信意图。Runtime 决定是否接受、补全、降级或用已保存证据重新生成。

## 设计规则

1. Handoff 以 Runtime record 保存；普通聊天消息只作为 raw evidence。
2. raw records 与 handoff summary 分开保存。
3. structured trace 只负责索引 raw records，不替代 raw records。
4. source Agent self-report 由 Runtime 在边界处请求；它是语义线索，不能直接当作事实。
5. 普通 Agent prompt 不承担完整 Handoff schema；复杂格式由 Runtime 和 handoff_writer 处理。
6. handoff_writer 读取 Source Bundle，并在需要时展开 raw refs。
7. 目标 Agent 默认接收 Markdown，不直接接收 canonical JSON。
8. 关键 claim 应尽量带 trace、artifact 或 raw ref。
9. Runtime 在交给目标 Agent 前执行 visibility、redaction、authority 和 budget 检查。

## 角色分工

### Assignment Brief

Assignment Brief 是 Runtime 给目标 Agent 的任务分派格式。它面向“接下来要做什么”，不面向“上一个会话完整发生了什么”。

Assignment Brief 应保持小而可执行：

```md
## Assignment

Goal: Review the toolbar undo state fix.
Status: `assigned`

### Scope

- Review changed toolbar/editor state files.
- Check whether focused tests cover the changed behavior.

### Out Of Scope

- Do not redesign unrelated toolbar actions.
- Do not run broad package tests unless the review finds a reason.

### Acceptance

- Return findings with evidence refs.
- Mark test coverage as sufficient, weak, or missing.

### Context

- Patch summary: `artifact://patch/undo_state#summary`
- Test summary: `artifact://test/undo_state#summary`
- Full raw session is available on demand: `artifact://raw/session/session_dev_01/full`
```

Assignment Brief 只内联目标 Agent 启动所需的信息。大文件、完整 transcript、完整 stdout、长 diff 和完整测试日志默认作为 ref 进入 Context Bundle，target Agent 通过 `context` 或 `expand_ref` 请求按需展开。

Assignment Brief 与 Result Handoff 的差异：

| 格式 | 用途 | 默认内容 |
|---|---|---|
| Assignment Brief | 分派新任务 | goal、scope、out_of_scope、acceptance、authority、dependencies、small context refs |
| Result Handoff | 回复和交接结果 | summary、evidenced facts、artifacts、risks、unresolved、next、raw refs、Runtime guidance |

### Source Agent

source Agent 执行任务。它在 terminal state 或 handoff boundary 收到 Runtime 的轻量提示后，留下一个短 self-report。

self-report 应保持扁平：

```txt
Status: partial
Goal: Fix auth timeout handling.

Done:
- Added timeout error path.
- Updated focused tests.

Artifacts:
- artifact://patch/current
- artifact://test/auth-timeout

Unresolved:
- Broader auth test suite still needs to run.

Risks:
- Only focused tests were run.

Next:
- Run broader auth tests.
- Review timeout behavior in refresh retry path.
```

self-report 的价值在于暴露 source Agent 认为重要的信息，例如取舍、风险、未验证项和推荐下一步。canonical handoff 由 Runtime 另行生成。

Runtime 不应每轮都要求 self-report。它只在边界处请求：

- Assignment 即将结束。
- source Agent 声明 blocked、partial 或 failed。
- Runtime 准备创建下游 session。
- 用户要求交接。
- context 或预算即将中断，需要保留现场。

如果 source Agent 未生成 self-report，Runtime 仍然继续 handoff 流程，用 structured trace 和 raw refs 生成 minimal handoff，并标记证据不完整。

### Runtime

Runtime 维护执行边界：

- 保存 raw records。
- 追加 Event records。
- 维护 structured trace。
- 索引 Artifact records。
- 判断是否触发 handoff plan。
- 在边界处请求 source Agent 生成轻量 self-report。
- 构造 Handoff Source Bundle。
- 在需要时调用 handoff_writer。
- 归一化并校验 Handoff records。
- 将 Handoff record 渲染为目标 Markdown。
- 写入 `handoff.self_report_requested`、`handoff.created`、`handoff.updated` 或 `handoff.rejected` events。

Runtime 不需要理解每一句领域语义。它需要保存足够材料和引用，让后续 reducer、Agent 或 human owner 可以复查。

### Handoff Writer

`handoff_writer` 是 hidden system Agent 或 reducer。它不获得执行用户任务的 authority，只负责整理 Runtime 提供的证据。

它接收：

- source Agent self-report
- structured trace timeline
- 相关 artifact summaries
- 关键 raw transcript excerpts
- full transcript 和 tool logs 的 raw refs
- assignment contract
- user goal
- decisions、blockers 和 unresolved questions

它输出 summary、facts、artifacts、unresolved、risks 和 next steps。Runtime 校验 draft 后再保存。

### Target Agent

target Agent 收到带 Handoff Markdown 的 Context Bundle。它可以通过正常的 context request 或 tool execution path 请求展开 refs。

target Agent 不继承 source Agent 的 authority。新的 Assignment 需要独立 routing、permission、budget 和 gate 检查。

## Raw Records

raw records 保存经过 Runtime 的原始材料：

- user messages
- model-visible context snapshots
- model outputs
- protocol declarations
- tool call arguments
- tool results
- command stdout 和 stderr
- patches、diffs 和 changed file snapshots
- generated artifacts
- permission requests 和 decisions
- UI 或 human owner decisions

raw records 可以存为 artifact、log 或 session archive segment。Handoff record 引用它们，不默认内联完整内容。

示例：

```txt
artifact://raw/session/session_dev_01/full
artifact://raw/model/output_006
artifact://raw/tool/test_stdout_010
artifact://patch/fix_undo_redo_state
```

## Structured Trace

structured trace 是 Runtime 对 raw material 建立的结构化过程索引。它记录顺序、归属、状态和引用。

structured trace 只提供过程索引。无损依赖 raw records。trace 的职责是让 raw records 可以定位、聚合、路由和审计。

Runtime 在这些边界写入 trace：

- assignment started / completed
- model context built
- model output received
- protocol declaration accepted / recovered
- Action accepted / started / completed / failed / blocked
- executor selected
- tool call requested
- tool result returned
- artifact declared / indexed
- patch applied
- test command completed
- permission requested / resolved
- decision requested / applied
- handoff created / updated / rejected

Trace entry 形态：

```json
{
  "seq": 10,
  "type": "tool.result",
  "run_id": "run_123",
  "session_id": "session_dev_01",
  "assignment_id": "assign_fix_toolbar",
  "action_id": "rerun_tests",
  "actor": {
    "type": "tool",
    "id": "bash"
  },
  "status": "completed",
  "summary": "Focused undo/redo state tests passed.",
  "refs": {
    "raw": "artifact://raw/tool/test_stdout_010",
    "artifact": "artifact://test/toolbar_passed_001"
  },
  "time": "2026-06-02T10:20:00Z"
}
```

Trace entry 的 identity、order、type、status、actor 和 refs 来自 Runtime instrumentation。`summary` 可以来自工具、executor result 或 reducer，但需要保留 raw ref。

## Handoff Source Bundle

Runtime 在调用 handoff_writer 前构造 Handoff Source Bundle。

Source Bundle 作为 reducer 输入；最终 handoff 由 Runtime 另行生成。

```json
{
  "type": "handoff.source",
  "version": "1",
  "id": "source_handoff_fix_toolbar",
  "source": {
    "run_id": "run_123",
    "session_id": "session_dev_01",
    "assignment_id": "assign_fix_toolbar",
    "agent_id": "code_developer"
  },
  "status": "completed",
  "goal": "Fix toolbar undo/redo buttons and run focused tests.",
  "contract": {
    "constraints": ["touch toolbar/editor state files only"],
    "required_artifacts": ["patch", "test_report"]
  },
  "self_report": {
    "summary": "Undo/redo state refresh was fixed and focused tests passed.",
    "risks": ["Full package suite was not run"]
  },
  "timeline": [
    {
      "seq": 5,
      "type": "tool.result",
      "summary": "Toolbar button dispatches command ids, but undo/redo disabled state comes from stale editor state.",
      "refs": ["artifact://source/toolbar_relevant_files"]
    },
    {
      "seq": 7,
      "type": "file.patch_applied",
      "summary": "Updated useEditorState.ts to refresh canUndo/canRedo after editor transactions.",
      "refs": ["artifact://patch/fix_undo_redo_state"]
    },
    {
      "seq": 10,
      "type": "tool.result",
      "summary": "Focused undo/redo state tests passed.",
      "refs": ["artifact://test/toolbar_passed_001"]
    }
  ],
  "artifacts": [
    {
      "ref": "artifact://patch/fix_undo_redo_state",
      "type": "patch",
      "summary": "Patch for editor state refresh."
    },
    {
      "ref": "artifact://test/toolbar_passed_001",
      "type": "test_report",
      "summary": "Focused undo/redo state tests passed."
    }
  ],
  "decisions": [],
  "unresolved": ["Full package test suite was not run."],
  "raw_refs": [
    "artifact://raw/session/session_dev_01/full",
    "artifact://raw/tool/test_stdout_010"
  ]
}
```

Source Bundle 分三层：

| 层级 | 用途 | 示例 |
|---|---|---|
| Level 1 | 必读上下文 | goal、status、contract、timeline、artifacts、unresolved、self-report |
| Level 2 | 关键原文片段 | final response、failed command excerpt、user correction、important model note |
| Level 3 | 原始材料引用 | full transcript、full tool logs、raw artifacts |

短会话可以内联更多 raw excerpts。长会话应优先提供 raw refs 和少量关键 excerpts。

## Handoff Writer 输出

handoff_writer 输出应保持扁平，便于校验和渲染。

```json
{
  "status": "completed",
  "summary": "Undo/redo toolbar state fix was implemented and focused tests passed.",
  "facts": [
    {
      "text": "Undo/redo state now refreshes after editor transaction updates.",
      "refs": ["artifact://patch/fix_undo_redo_state"]
    },
    {
      "text": "Focused undo/redo state tests passed.",
      "refs": ["artifact://test/toolbar_passed_001"]
    }
  ],
  "artifacts": [
    "artifact://patch/fix_undo_redo_state",
    "artifact://test/toolbar_passed_001"
  ],
  "decisions": [],
  "risks": ["Full package test suite was not run."],
  "unresolved": ["Full package test suite was not run."],
  "next": [
    "Run broader package tests if preparing for merge.",
    "Review whether other toolbar buttons depend on the same transaction-state refresh path."
  ],
  "raw_refs": ["artifact://raw/session/session_dev_01/full"]
}
```

没有 ref 的 claim 不能进入 evidenced facts。Runtime 可以把它降级为 `note` 或 `assumption`。

## Canonical Handoff Record

Runtime 将 writer output 归一化为 canonical Handoff record。

```json
{
  "type": "handoff",
  "version": "1",
  "id": "handoff_fix_toolbar_to_review",
  "source": {
    "run_id": "run_123",
    "session_id": "session_dev_01",
    "assignment_id": "assign_fix_toolbar",
    "agent_id": "code_developer"
  },
  "target": {
    "executor": "agent",
    "capability": "code_review"
  },
  "status": "completed",
  "goal": "Review the toolbar undo/redo state fix.",
  "summary": "Undo/redo toolbar state fix was implemented and focused tests passed.",
  "facts": [
    {
      "text": "Undo/redo state refreshes after editor transaction updates.",
      "refs": ["artifact://patch/fix_undo_redo_state"],
      "confidence": "evidenced"
    },
    {
      "text": "Focused undo/redo state tests passed.",
      "refs": ["artifact://test/toolbar_passed_001"],
      "confidence": "evidenced"
    }
  ],
  "artifacts": [
    {
      "ref": "artifact://patch/fix_undo_redo_state",
      "type": "patch",
      "status": "available",
      "summary": "Patch for editor state refresh."
    },
    {
      "ref": "artifact://test/toolbar_passed_001",
      "type": "test_report",
      "status": "available",
      "summary": "Focused undo/redo state tests passed."
    }
  ],
  "decisions": [],
  "constraints": ["Review changed toolbar/editor state files first."],
  "risks": ["Full package test suite was not run."],
  "unresolved": ["Full package test suite was not run."],
  "next": [
    {
      "goal": "Run broader package tests if preparing for merge.",
      "depends_on": ["artifact://patch/fix_undo_redo_state"]
    }
  ],
  "raw_refs": ["artifact://raw/session/session_dev_01/full"],
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "trace": "summary",
    "future_runs": "ref"
  },
  "created_by": "runtime"
}
```

Runtime 校验项：

- referenced artifacts 存在，且 target 可见。
- trace refs 属于 source run 或允许的 upstream run。
- 无 refs 的 claim 被标为 notes 或 assumptions。
- target executor 可用，并且独立授权。
- redaction policy 已在 target context rendering 前应用。
- unresolved items 没有被无证据删除。
- raw refs 被保留，用于 audit 和 on-demand expansion。

## Result Handoff Markdown 渲染

target Agent 默认收到 Markdown，不直接读 canonical JSON。Result Handoff 面向“理解结果并继续推理”，因此 Runtime 需要加入少量语义提示，说明哪些内容是已验证事实，哪些只是 note、assumption、risk 或 unresolved item。

```md
## Result Handoff

Source: `code_developer`
Status: `completed`

### Runtime Guidance

- This is a compressed Runtime projection, not the full source session.
- Treat `Ref:` lines as evidence pointers. Expand them only when exact detail is needed.
- Treat notes as unevidenced context and unresolved items as still open.
- Full raw evidence is stored by ref and is not loaded into context by default.

### Goal

Review the toolbar undo/redo state fix.

### What Was Done

- Undo/redo state now refreshes after editor transaction updates.
  Ref: `artifact://patch/fix_undo_redo_state`

- Focused undo/redo state tests passed.
  Ref: `artifact://test/toolbar_passed_001`

### Available Artifacts

- `artifact://patch/fix_undo_redo_state`
  Patch for editor state refresh.

- `artifact://test/toolbar_passed_001`
  Focused undo/redo state test report.

### Remaining Risk

- Full package test suite was not run.

### Suggested Next Steps

1. Run broader package tests if preparing for merge.
2. Review whether other toolbar buttons depend on the same transaction-state refresh path.

### Raw Evidence

- Full source session: `artifact://raw/session/session_dev_01/full`
```

Markdown 是 canonical Handoff record 的投影，不作为事实来源。

Runtime 渲染 Result Handoff 时应优先返回：

- 1 到 3 句 summary。
- 带 ref 的 facts。
- artifact refs 和短说明。
- risks、unresolved 和 next steps。
- raw refs。

Runtime 不应默认内联：

- full transcript。
- full stdout/stderr。
- long diff。
- long file content。
- repeated failed attempts。
- 与目标任务无关的 child session 内容。

## 噪音控制

Runtime 在 handoff 进入目标上下文前应控制噪音：

- 合并 action signature 相同的重复 tool calls。
- 只保留能解释 decision、risk 或 blocker 的 failed attempts。
- 将被后续证据推翻的 hypotheses 标为 superseded。
- 保留用户修正和后续决策。
- 按文件、命令和 artifact 分组。
- full stdout 和 stderr 保留在 raw refs 中。
- validation artifacts 保留精确 command string。
- 不复制无关 child session transcripts。

如果 self-report 与 structured trace 冲突，handoff 应暴露冲突：

```md
### Conflict

- Source self-report says focused tests passed.
- Structured trace has no passing test artifact.
- Treat test status as unresolved until a test artifact is produced.
```

## 信息保全

Handoff 不能保证每个语义细节都被摘要捕捉。协议要让遗漏更容易发现和恢复。

信息保全要求：

- 附带 full raw source session ref。
- 关键 fact 尽量带 refs。
- unresolved items 复制到下游。
- `failed` 和 `blocked` 终态包含 failure reason refs。
- handoff_writer 可以在定稿前展开 raw refs。
- target Agent 可以通过 context request 展开 raw refs。
- Runtime 记录 handoff 是否基于 incomplete evidence 生成。

高风险任务可以要求 handoff 二次审查：

- release 或 deploy
- security review
- data migration
- permission 或 credential handling
- destructive filesystem changes
- user-facing legal、financial 或 medical content

## 失败处理

source Agent self-report 缺失时：

- Runtime 使用 structured trace 和 raw refs。
- Handoff status 增加 `self_report_missing` 诊断。

handoff_writer 输出未通过校验时：

- Runtime 使用更小、更严格的 Source Bundle 重试。
- 如果重试仍失败，Runtime 从确定性字段创建 minimal handoff。

Minimal handoff：

```json
{
  "status": "partial",
  "summary": "Source assignment ended, but handoff writer output was invalid.",
  "artifacts": ["artifact://patch/current"],
  "unresolved": ["Review raw source session before continuing."],
  "raw_refs": ["artifact://raw/session/session_dev_01/full"]
}
```

raw refs 缺失时：

- Runtime 不应将 handoff 标为 fully evidenced。
- target context 应说明 raw evidence missing。
- 高风险 downstream actions 应进入 review 或 approval gate。

## Event 类型

协作通信使用现有 Event 和 Trace 基础设施。通用事件记录通信原语，handoff 专用事件记录接力上下文的生成过程。

推荐通用事件类型：

- `communication.planned`
- `communication.accepted`
- `communication.rejected`
- `communication.rendered`
- `communication.consumed`
- `assign.created`
- `sync.received`
- `sync.projected`

推荐 handoff 专用事件类型：

- `handoff.self_report_requested`
- `handoff.source_built`
- `handoff.writer_started`
- `handoff.writer_completed`
- `handoff.writer_failed`
- `handoff.created`
- `handoff.updated`
- `handoff.rejected`

示例：

```json
{
  "id": "evt_handoff_001",
  "seq": 84,
  "time": "2026-06-02T10:30:00Z",
  "scope": "run",
  "type": "handoff.created",
  "actor": {
    "type": "runtime",
    "id": "runtime"
  },
  "run_id": "run_123",
  "assignment_id": "assign_fix_toolbar",
  "data": {
    "handoff_id": "handoff_fix_toolbar_to_review",
    "source_session": "session_dev_01",
    "status": "completed",
    "target_capability": "code_review"
  },
  "refs": [
    "artifact://patch/fix_undo_redo_state",
    "artifact://test/toolbar_passed_001"
  ],
  "prev": "evt_083"
}
```

## 与现有协议的关系

Model-Runtime Protocol 可以通过 `calls[]` 表达 `assign` intent，也可以通过 Runtime call 显式创建 `assign`、`handoff` 或 `sync`。`calls[].handoff` 仍可作为兼容输入进入 normalization，但 canonical record 应使用 `kind` 区分通信原语。

Runtime 可以提供三个边界调用：

- `communication.plan`：根据 Assignment 状态、下游依赖、policy、用户触发和预算状态判断是否创建 `assign`、`handoff` 或 `sync`。
- `handoff.self_report.request`：只在 handoff boundary 主动向 source Agent 请求轻量 self-report，并写入事件。
- `sync.normalize`：将 Agent result、review findings、blocked reason 或 Runtime error 归一化为 `sync` record。

Routing and Delegation Policy 负责 target selection、Assignment creation 和 repair/review loop 的 target resolution。

State, Event and Projection Model 负责存储 communication events、handoff chain、sync status、trace refs 和 artifact index。

Context, Memory and Visibility Policy 决定 communication record 的哪些部分进入 model context、user UI、logs 和 future runs。

UI Console 展示 communication chain，并允许用户从 session summary、artifact、review finding 或 unresolved issue 创建后续 Assignment。

## 实现路径

第一版实现不应要求普通 Agent prompt 生成完整 communication schema。建议路径：

1. 为当前执行边界补充 Runtime trace entries 和 raw refs。
2. terminal Assignment flow、用户 intent 或 Runtime policy 调用 `communication.plan`。
3. `kind = assign` 时，Runtime 收集 projection、trace、artifact refs，并在需要时调用 assignment_builder 生成任务合同。
4. `kind = handoff` 时，保存 full source session raw ref；如果 plan 要求 self-report，调用 `handoff.self_report.request`。
5. Runtime 收集 self-report、events、artifacts 和 raw refs，创建 Handoff Source Bundle。
6. `kind = handoff` 时调用 hidden `handoff_writer`。
7. `kind = sync` 时调用 `sync.normalize` 或确定性 reducer，归一化 status、evidence、needs 和 next action。
8. 用扁平 schema 校验 writer 或 reducer output。
9. 保存 canonical communication record。
10. 将 communication record 渲染成 Markdown，放入 target Context Bundle 或投影到 parent session。

source Agent prompt 可以加入一条轻量规则：

```txt
When Runtime asks for a handoff self-report, write concise plain-text notes
about completed work, key artifacts, evidence, risks, unresolved questions and
suggested next steps. These notes help Runtime build a handoff, but Runtime
will validate and rewrite the final handoff record.
```

这条规则降低格式压力，同时保留 source Agent 的现场判断。
