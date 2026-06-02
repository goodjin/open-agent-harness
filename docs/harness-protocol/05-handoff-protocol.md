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

## 核心流程

```txt
source Agent Session 执行任务
  -> Runtime 保存 raw records 和 structured trace
  -> Runtime 判断是否到达 handoff boundary
  -> Runtime 在需要时请求 source Agent 生成轻量 self-report
  -> Runtime 构造 Handoff Source Bundle
  -> handoff_writer 将 source bundle 压缩为 handoff draft
  -> Runtime 归一化、校验并保存 canonical Handoff record
  -> 目标 Context Bundle 收到由 Handoff record 渲染出的 Markdown
```

handoff 的触发权在 Runtime。source Agent 可以提出 handoff intent，但 intent 只是输入，不等于正式交接。Runtime 需要根据 run state、assignment state、policy、用户操作和上下文预算决定是否创建 handoff。

Runtime 在这些场景计划 handoff：

- **Assignment 终态**：Assignment `completed`、`partial`、`blocked`、`failed`，或执行被取消但已有可用现场。
- **下游依赖存在**：当前 Assignment 有 `next`、review、test、merge、follow-up、fan-in 聚合或其他 depends。
- **模型提出 intent**：source Agent 在协议输出里声明需要交给 reviewer、tester、human owner 或另一个 capability。
- **Orchestration Policy 命中**：例如 implementation 结束后进入 code review，review 结束后进入 test audit。
- **用户或 UI 手动触发**：用户指定“交给下一个 Agent”、“让 human 看一下”或从 Console 创建 continuation。
- **Runtime 限制触发**：context budget 接近耗尽、预算不足、权限不足、工具不可用或当前 executor 无法继续。
- **final continuation**：final answer 后需要为 future run 留下可恢复的工作状态。

Runtime 的计划结果应包含：

```json
{
  "type": "handoff.plan",
  "trigger": true,
  "reasons": ["assignment_terminal", "downstream_next"],
  "request_self_report": true,
  "status": "completed"
}
```

source Agent 可以在协议输出里提出 handoff 意图。Runtime 决定是否接受、补全、降级或用已保存证据重新生成。

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

## 目标 Markdown 渲染

target Agent 默认收到 Markdown，不直接读 canonical JSON。

```md
## Handoff

Source: `code_developer`
Status: `completed`

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

Handoff 使用现有 Event 和 Trace 基础设施。

推荐事件类型：

- `handoff.self_report_requested`
- `handoff.source_built`
- `handoff.writer_started`
- `handoff.writer_completed`
- `handoff.writer_failed`
- `handoff.created`
- `handoff.updated`
- `handoff.rejected`
- `handoff.rendered`
- `handoff.consumed`

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

Model-Runtime Protocol 可以通过 `calls[].handoff` 表达 handoff intent，也可以通过 Runtime call，例如 `handoff.create`，显式创建 handoff。

Runtime 可以提供两个边界调用：

- `handoff.plan`：根据 Assignment 状态、下游依赖、policy、用户触发和预算状态判断是否触发 handoff。
- `handoff.self_report.request`：在 handoff boundary 主动向 source Agent 请求轻量 self-report，并写入事件。

Routing and Delegation Policy 负责 target selection 和 Assignment creation。

State, Event and Projection Model 负责存储 handoff events、handoff chain、trace refs 和 artifact index。

Context, Memory and Visibility Policy 决定 Handoff record 的哪些部分进入 model context、user UI、logs 和 future runs。

UI Console 展示 handoff chain，并允许用户从 session summary、artifact 或 unresolved issue 创建后续 Assignment。

## 实现路径

第一版实现不应要求普通 Agent prompt 生成完整 Handoff schema。建议路径：

1. 为当前执行边界补充 Runtime trace entries 和 raw refs。
2. 保存 full source session raw ref。
3. terminal Assignment flow 或 Runtime policy 调用 `handoff.plan`。
4. 如果 plan 要求 self-report，调用 `handoff.self_report.request`，向 source Agent 发轻量 plain-text prompt。
5. Runtime 收集 self-report、events、artifacts 和 raw refs，创建 Handoff Source Bundle。
6. 调用 hidden `handoff_writer`。
7. 用扁平 schema 校验 writer output。
8. 保存 canonical Handoff record。
9. 将 Handoff record 渲染成 Markdown，放入 target Context Bundle。

source Agent prompt 可以加入一条轻量规则：

```txt
When Runtime asks for a handoff self-report, write concise plain-text notes
about completed work, key artifacts, evidence, risks, unresolved questions and
suggested next steps. These notes help Runtime build a handoff, but Runtime
will validate and rewrite the final handoff record.
```

这条规则降低格式压力，同时保留 source Agent 的现场判断。
