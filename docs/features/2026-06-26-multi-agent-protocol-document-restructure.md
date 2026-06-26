# Multi-Agent Protocol Document Restructure

## 用户目标

按照近期实现迭代，以新版本形式编写协议文档，让协议文档从整体上围绕「多 Agent 协作」展开，而不是只按零散接口、状态字段或历史实现堆叠说明。

新的文档脉络需要先定义 Agent，再对核心对象建模，随后说明对象之间的关系和协作机制，最后落到具体的模型交互协议、运行时协议、异常处理和观测恢复规则。

## 已确认范围

- 梳理当前实现作为文档修订依据。
- 新增一套 v2 协议文档，旧版 `docs/harness-protocol/` 先保留为历史参考。
- 补充或重写 Agent 定义、会话状态、Assignment 机制。
- 明确 Agent、Session、Turn、Task、Assignment、Action、Result、Event 等对象模型。
- 明确多 Agent 协作中的父子关系、委托关系、依赖满足、结果回传、人工交互和异常恢复。
- 本轮作为文档重构任务，不修改运行时代码、数据库 schema 或模型协议实现。
- v2 文档独立成套交付；是否把旧版入口切到 v2，留到文档审阅后再决定。
- 以当前代码实现为事实来源；历史兼容字段可以保留说明，但不作为主协议入口。

## 当前实现梳理重点

### Agent

- Agent 是可被运行时调度的能力单元，需要区分 Agent 定义和 Agent 会话实例。
- Agent 定义包含名称、类型、入口、权限边界、可用工具、协议族、模型绑定和并发/路由约束。
- Agent 会话实例是一次具体运行，承载运行状态、上下文、输入输出、任务归属和结果记录。
- Planner / Coordinator 类 Agent 使用 `AgentProtocolOutput` 作为模型到运行时的结构化协议。
- Worker / Verifier 类 delegated session 以 `ActionResult` 作为任务完成结果载体。

### Session 和 Turn

- Session 是运行时可恢复、可观察、可被委托和被交互的执行容器。
- Turn 是用户请求或恢复输入驱动的一次运行周期，生命周期和 Session 生命周期分开。
- 当前实现中 `SessionTurn` 管理一次用户请求的 `queued -> running -> done` 流程。
- Session 状态由 `SessionStatus` 统一描述，DB 中的 `session.status_*` 字段是当前生命周期状态来源；旧 JSON 状态文件只作为历史产物说明。

### Task 和 Assignment

- Task 是用户或上级 Agent 期望完成的工作目标。
- Assignment 是 Task 在某个 Session/Agent 上的运行时归属和可编辑投影，不等同于任务正文。
- Assignment 来源包括用户确认创建和 delegation 创建。
- 当前实现中 `confirm.plan` 保存完整任务内容，`confirm.assignment` 只表达运行时 mutation 元数据，例如 create / update / select。
- Assignment 内容以 revision 形式持久化，DB 行承担索引、状态和当前版本投影。

### Result 和 Fan-in

- `SessionResult` 是跨 Agent 传递结果的标准事实记录。
- 父子 Session 之间的结果投递、依赖满足和 UI 展示是三个分开的层次。
- 子 Session 到达终态后，需要通过状态事件触发 fan-in；终态结果可能已投递，但不一定满足依赖。
- `reply`、失败、fallback summary 和 synthetic terminal status result 应作为终态结果处理，但不能默认满足普通依赖。

### Interaction

- `confirm` 是对待执行包或 Assignment mutation 的人工确认门。
- `input` 是协议级用户补充信息门。
- pending confirmation/input 会从 protocol context 恢复，并通过继续同一个 Session 的方式完成交互闭环。

## 文档重构原则

1. 先讲多 Agent 协作模型，再讲具体协议字段。
2. 先定义对象，再定义对象之间的关系。
3. 先讲稳定概念，再讲实现投影和兼容层。
4. 明确区分模型可见协议、运行时内部协议、持久化投影和 UI 展示事件。
5. 明确哪些状态是会话生命周期状态，哪些只是交互门、任务状态或依赖状态。
6. 明确 Assignment 是任务归属和执行投影，不把它写成另一个 Task 实体。
7. 历史 `kind: "act"` / `calls[]` 等兼容格式只放在兼容说明中，不再作为主协议叙述入口。

## 建议文档脉络

### 1. 多 Agent 协作总览

说明 Harness 协议解决的问题：多个 Agent 在同一项目上下文中协作完成复杂任务，每个 Agent 有明确能力边界、运行容器、任务归属、结果输出和交互规则。

需要覆盖：

- Agent 如何被定义和选择。
- Session 如何承载一次 Agent 运行。
- Task 如何被拆解、委托和确认。
- Assignment 如何表达任务归属。
- Result 如何在父子 Session 之间回传。
- 用户交互和异常恢复如何进入同一套协议。

### 2. Agent 定义

单独成章定义 Agent。

需要覆盖：

- Agent Template：静态定义，包括 id、kind、prompt、tools、protocol、runner、capability、权限边界。
- Agent Instance：绑定到一个 Session 的运行实例。
- Agent Role：planner、coordinator、worker、verifier、reviewer 等角色只是调度语义，不应和协议载体混用。
- Agent Protocol Family：不同 Agent 角色使用不同输出载体，例如 `AgentProtocolOutput` 或 `ActionResult`。
- Agent Authority：哪些 Agent 可以创建任务、委托子任务、请求用户确认、完成 Assignment 或只返回审查结果。

### 3. 对象模型

把协议中的核心对象集中建模。

需要覆盖：

- Project：项目上下文和持久化边界。
- Agent：能力定义和运行身份。
- Session：一次可恢复执行容器。
- Turn：一次用户输入或恢复输入驱动的运行周期。
- Task：目标工作单元。
- Assignment：Task 到 Agent/Session 的归属和执行投影。
- Action：模型请求运行时执行的操作。
- Interaction：confirm / input 等人工交互门。
- Result：Session 完成后可被投递和观察的结果记录。
- Event：状态、结果、UI timeline 和 outbox 的通知事实。

### 4. 关系模型

在对象之后说明关系。

需要覆盖：

- Agent 定义和 Session 实例的关系。
- Session 和 Turn 的关系。
- Task 和 Assignment 的关系。
- Parent Session 和 Child Session 的 delegation 关系。
- Action 和 Result 的关系。
- Result delivery 和 dependency satisfaction 的关系。
- Session 状态、Assignment 状态、Task 进度和 UI timeline 事件的关系。

### 5. Assignment 机制

建议单独成章或作为对象关系章节的重点小节。

需要覆盖：

- Assignment 的创建来源：用户确认、delegation。
- Assignment 的更新语义：create / update / select / complete。
- Assignment 内容版本：revision、raw content、DB projection。
- Assignment gate 和 planner confirm 的边界。
- resumed delegated flow 中 delegation context 与 active assignment 的关系。
- Assignment 如何影响继续执行、用户确认、任务展示和结果归属。

### 6. Session 状态与生命周期

需要重新整理当前状态文档，使状态服务于协作协议。

需要覆盖：

- Session lifecycle：created / queued / running / waiting_child / waiting_input / waiting_confirm / stopped / completed / failed / interrupted 等语义。
- Turn lifecycle：queued / running / done。
- Terminal、recoverable、manual continue、auto continue 的判定边界。
- bootstrap restore、delegation init、terminal child fan-in 的顺序。
- DB projection、历史 JSON 状态产物、UI projection 的职责边界。

### 7. 交互协议

需要把用户交互从零散状态中抽出来说明。

需要覆盖：

- `confirm`：确认待执行包、确认 Assignment mutation。
- `input`：补充缺失信息。
- `reply`：向用户回复但不满足依赖。
- 用户接受、拒绝、补充输入后如何继续同一个 Session。
- pending interaction 如何持久化和恢复。

### 8. 模型到运行时协议

在前面对象和关系定义清楚后，再定义具体协议格式。

需要覆盖：

- `AgentProtocolOutput` v2 的 `items[]` 结构。
- `tool`、`agent`、`input`、`confirm`、`answer`、`done`、`success`、`failure`、`error`、`reply` 等 item 语义。
- Planner / Coordinator 的协议约束。
- Worker / Verifier 的 `ActionResult` 结果协议。
- `ActionResult` 和 `AgentProtocolOutput` 的边界。
- 兼容格式和废弃格式说明。

### 9. 异常处理与恢复

需要把异常处理写成协作协议的一部分。

需要覆盖：

- 模型输出格式错误。
- tool / agent action 失败。
- 子 Session 终止但未产生满足依赖的结果。
- 用户拒绝 confirm。
- 用户输入缺失或交互恢复失败。
- Session interrupted、stale tool、manual continue、auto continue。
- Result fallback 和 non-satisfying terminal result 的处理规则。

### 10. 观测、投影和 UI

需要说明协议事实如何投影到日志、DB、outbox 和 UI timeline。

需要覆盖：

- `session_result` 作为结果事实。
- `session_event_outbox` 作为跨进程事件通知。
- `part` / `session_log` / timeline 的显示职责。
- parent/child projection 只保存引用，不复制完整结果。
- UI 中哪些状态是执行状态，哪些是等待交互或等待子任务。

## 计划文档落点

### 新版本目录

- `docs/harness-protocol-v2/README.md`
- `docs/harness-protocol-v2/00-multi-agent-collaboration-overview.md`
- `docs/harness-protocol-v2/01-agent-definition.md`
- `docs/harness-protocol-v2/02-object-and-relationship-model.md`
- `docs/harness-protocol-v2/03-assignment-and-delegation.md`
- `docs/harness-protocol-v2/04-session-state-and-lifecycle.md`
- `docs/harness-protocol-v2/05-interaction-protocol.md`
- `docs/harness-protocol-v2/06-model-runtime-protocol.md`
- `docs/harness-protocol-v2/07-error-recovery-protocol.md`
- `docs/harness-protocol-v2/08-observability-and-projection.md`

### 旧版文档处理

- 旧版 `docs/harness-protocol/` 暂不覆盖。
- v2 完成并审阅后，再决定是否更新旧版 README、迁移编号或替换入口。
- v2 文档可以引用旧版术语，但以当前实现为准重新定义对象、关系和协议边界。

## 旧版文档参考范围

### 主要协议文档

- `docs/harness-protocol/00-harness-governance-protocol.md`
  - 作为旧版总纲参考，不在本轮直接覆盖。

- `docs/harness-protocol/01-agent-model-and-authoring.md`
  - 作为 Agent 定义和外部 authoring 兼容参考。

- `docs/harness-protocol/02-model-runtime-protocol.md`
  - 作为模型到运行时协议历史参考。

- `docs/harness-protocol/06-state-event-projection-model.md`
  - 作为状态、事件和投影历史参考。

### 相关模块文档

- `docs/harness-module/` 中与 session、protocol、delegation、assignment、UI console 相关的模块文档需要按实际修订情况同步。
- 如果没有合适模块文档承载 Assignment 或 result fan-in 说明，应新增或扩展对应模块文档。

## 执行步骤

1. 再次从代码中核对当前实现入口：
   - `packages/opencode/src/protocol/schema.ts`
   - `packages/opencode/src/session/llm.ts`
   - `packages/opencode/src/session/action-result.ts`
   - `packages/opencode/src/session/assignment.ts`
   - `packages/opencode/src/session/status.ts`
   - `packages/opencode/src/session/result.ts`
   - `packages/opencode/src/session/delegation.ts`
   - `packages/opencode/src/session/session.sql.ts`
   - `packages/opencode/src/session/turn.ts`
   - `packages/opencode/src/project/bootstrap.ts`
   - `packages/opencode/src/server/routes/question.ts`
2. 梳理现有 `docs/harness-protocol/` 的章节内容和交叉引用。
3. 新建 `docs/harness-protocol-v2/`。
4. 按「Agent -> 对象 -> 关系 -> 协作机制 -> 协议 -> 异常和恢复」编写 v2 总览。
5. 编写 Agent 定义章节。
6. 编写对象与关系模型章节。
7. 编写 Assignment、delegation 和 result fan-in 章节。
8. 编写 Session 状态、交互协议、模型运行时协议、异常恢复和观测投影章节。
9. 检查链接、编号、术语一致性和废弃格式表述。

## 验证计划

- 使用 `rg` 检查协议文档中 `AgentProtocolOutput`、`ActionResult`、`Assignment`、`SessionResult`、`waiting_child` 等术语是否一致。
- 使用 `rg` 检查旧协议表述 `kind: "act"` / `calls[]` 是否只出现在兼容说明中。
- 检查所有新增或变更 Markdown 链接是否存在。
- 不运行代码测试；本任务为文档重构，不改运行时代码。

## 风险和待确认点

- v2 文档完成后，是否把 `docs/harness-protocol/README.md` 入口切到 v2，需要审阅后再决定。
- Assignment 机制在 v2 中单独成章，避免被状态章节吞掉。
- 是否需要在协议文档中保留数据库字段级说明。当前建议是保留关键投影字段，但把完整字段细节放到模块文档或实现参考中。

## 交付标准

- 协议文档读起来先说明多 Agent 协作模型，再进入具体协议。
- Agent、Session、Task、Assignment、Action、Result、Event 的定义清楚且互不混用。
- Session 状态、交互门、任务归属、结果投递、依赖满足分别有清晰边界。
- Planner / Coordinator 的 `AgentProtocolOutput` 和 Worker / Verifier 的 `ActionResult` 分工明确。
- 异常处理和恢复规则能解释当前实现中的 interrupted、waiting_child、reply、fallback result、manual continue 和 auto continue。
