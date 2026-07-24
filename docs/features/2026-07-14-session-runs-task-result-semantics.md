# Session Runs 任务与结果语义

## 用户目标

Runs 页面中的一个 Run 代表模型通过可执行 Agent Protocol DSL 正式分派的一项任务，而不是一条用户消息、一次澄清对话或一个普通模型回复。

每个 Run 都应展示完整的任务内容和最终结果：

- 父会话在该 Run 的全部子任务返回后，由模型综合结果并判断任务结束，模型输出的内容是该 Run 的 `summary`。
- 子会话完成委派任务后，返回父会话的 `ActionResult.result` 是该子会话最终 Run 的 `summary`；无法生成合法 ActionResult 时使用 fallback summary。

## 已确认语义

### Run 创建边界

- 用户请求、补充信息、需求澄清和方案讨论本身不创建 Run。
- 模型输出至少包含一个实际执行任务的 `agent`、`tool` 或 runtime action，并由 Runtime 接受执行时，创建一个 Run。
- 同一 DSL 包中的 actions 是该 Run 的子任务，不拆成多个顶层 Run。
- 模型后续再次输出新的可执行 DSL 包时，创建新的 Run。
- 模型通过 DSL 包的边界决定哪些子任务属于同一个 Run。
- 父会话 DSL 中的 `agent` action 创建子会话时，该委派任务同时成为子会话可见的一个 Run。子会话无需再次输出 DSL 才能看到这项任务。
- 只有 `input` 的协议包属于需求澄清，不创建 Run。
- 只有 `confirm` 的协议包属于批准流程，不创建 Run；不带 Task assignment 的普通 `confirm` 与实际执行任务同包时，在用户批准并开始执行后创建 Run。带 `create/self` 或 `update/self` 的确认包忽略同包执行项，确认后由下一模型回合生成执行图。
- 只有 `answer`、`done`、`success`、`failure`、`error` 或 `reply` 等终态内容、且不包含可执行项的协议包，不创建新的 Run。

### Run 完成边界

- actions 执行完成、失败或被阻塞，只表示执行阶段收敛，不代表 Run 已经拥有最终结果。
- 父会话收到全部相关子任务结果后，由模型输出对该 Run 的综合判断。
- Runtime 保存综合判断后，Run 才进入带结果的终态。
- 如果模型在综合上一 Run 后继续分派任务，当前 DSL 输出先结束上一 Run，其中的新可执行 actions 再创建下一个 Run。
- 运行中的 Run 不展示最终结果，避免把局部 action 输出误当作整体结论。

## Run 数据含义

Runs API 保持任务包视角，但需要区分任务结果和执行统计：

- `run_id`：Runtime 接受可执行 DSL 包时生成的 Run ID。
- `title`：DSL 包标题；缺失时从主要 action 标题生成稳定回退标题。
- `task`：Run 的整体任务内容，由 DSL 标题、说明以及 actions 的目标和 prompt 组成。
- `actions`：同一 DSL 包内的子任务、依赖、目标 Agent、状态和局部输出。
- `summary`：该 Run 对父级调用方或用户交付的最终结果。
- `execution_summary`：可选的内部执行摘要，例如 action 完成数、失败数和阻塞原因。
- `documents`：当前 Run 对应 `.harness` 目录中的 Markdown 文档。

子会话中的委派 Run 复用父协议 Run ID，并通过 `action_id` 确认具体委派。Run ID 在单个子会话内保持唯一；父子会话通过 session ID 隔离，避免同名 Run 相互覆盖。

现有 `AgentProtocolExecutor` 生成的“action 标题 + 状态”文本不再作为 Runs 页面中的最终 `summary`。它可以保留为执行器内部信息，或映射为 `execution_summary`。

## 父会话结果

父会话包括 `default`、`milestone-planner`、`feature-planner` 及其他通过协议包协调子任务的会话。

1. 模型输出可执行 DSL 包。
2. Runtime 创建 Run，保存任务内容和 actions。
3. Runtime 执行本地工具，并创建需要的子会话。
4. 子任务通过 canonical `SessionResult` 返回，父会话完成 fan-in。
5. 模型读取全部结果，输出当前 Run 的综合判断。
6. Runtime 将规范化后的协议终态内容保存为该 Run 的 `summary`。
7. 如果同一输出还包含新的可执行 actions，Runtime 为这些 actions 创建下一个 Run。

协议终态内容统一按现有 Agent Protocol 规则读取 `message`、`answer`、`text` 和 `summary`，并保留需要展示的 changed files 信息。Runs 不使用短期 Session Log 作为长期结果来源。

为了保证每个父会话 Run 都有模型判断后的结果，planner protocol 需要明确：处理一个已完成执行阶段的 Run 时，下一次协议输出必须携带该 Run 的结果。若模型只继续分派而未提供上一 Run 的结果，Runtime 应进入协议修复流程，不能用 action 状态列表冒充模型结论。

## 子会话结果

当前会话存在父级委派关系时，其最终交付结果从 canonical `SessionResult` 读取：

1. `carrier === "action_result"`：使用 `action_result.result`。
2. `carrier === "fallback_summary"`：使用持久化的 Markdown `output`，缺失时使用 canonical `summary`。
3. 兼容 protocol runner 子会话：使用终态协议项的 `message`，其次为终态 `summary`。

不得把完整 ActionResult JSON 当作最终文本展示。`changed_files`、`verification`、`blockers`、`issues` 和 `evidence` 等字段可作为结果详情，但 `run.summary` 只保存返回父会话的主要结果内容。

子会话收到委派后，即使只直接执行任务并返回 ActionResult，也应在 Runs 页面看到委派 Run。任务内容来自父 DSL action 的标题和完整 prompt，状态来自子会话 runtime 与 SessionResult，结果来自 ActionResult 或 fallback summary。

如果子会话少数情况下继续输出 DSL 分派自己的子任务，这些 DSL 包形成额外的子会话本地 Run。委派 Run 仍表示子会话收到的整体任务，其 `summary` 是最终返回父会话的 ActionResult 或 fallback summary；内部 Run 各自保存模型对该阶段的综合结果，不复制整体 ActionResult。

## 持久化方案

采用现有存储边界，不新增一套与 `SessionResult` 竞争的结果真相源：

- `session_protocol_run/<session_id>/<run_id>` 继续保存 Run 的任务、actions、时间和指标。
- 父会话模型生成 Run 结果后，Runtime 将规范化结果投影回对应的持久化 Run。
- 子会话结果继续以 `session_result` 为 canonical truth，通过 `result_id` 读取完整 payload。
- 子会话委派 Run 从 delegation 和 SessionResult 生成持久化投影，不复制 canonical payload。
- `dsl_context.protocol.runs` 只保留当前运行状态和轻量结果投影，不保存完整 ActionResult payload。
- `.harness/sessions/<session_id>/runs/<run_id>/` 继续作为该 Run 的本地规划文档目录。

写入 Run 结果时需要校验 session、run 和结果来源的关联，避免把其他会话或其他 Run 的 SessionResult 投影到当前 Run。

## 历史数据兼容

- 已持久化但只有执行器状态摘要的 Run，不能把旧 `summary` 标记为最终任务结果。
- 对父会话历史记录，可通过 Run 关联的 assistant message 和 `protocol_response` part 恢复已存在的模型终态内容。
- 对子会话历史记录，优先通过 `dsl_context.result.result_id` 读取 canonical SessionResult；轻量投影缺失时按 parent session、child session、run 和 action 关联查询。
- 无法可靠找到最终结果时，页面显示“未记录最终结果”，保留 actions 和文档，不猜测或拼接结果。
- Session Log 只用于诊断和历史回退，不作为长期唯一关联依据。

## Runs 界面

左侧列表中的每个条目对应一个可执行 DSL Run，或当前子会话收到的委派 Run，展示：

- Run 标题和 ID
- 运行状态
- 开始和完成时间
- 子任务完成进度
- 文档数量
- 是否已经记录最终结果

Run 详情按以下顺序展示：

1. **任务内容**：整体目标和 DSL actions 的任务要求。
2. **运行结果**：终态后展示 `run.summary`，支持 Markdown；运行中不展示空结果卡片。
3. **子任务**：action 标题、目标 Agent 或工具、prompt、依赖、状态、局部摘要和错误。
4. **文档**：requirements、designs、plans、reviews 和 manifest。
5. **执行信息**：时间、指标和内部执行摘要，作为辅助诊断信息。

失败、阻塞和 fallback 需要明确标识来源。fallback summary 表示结果已交付，不代表验证通过，也不改变子会话原有 runtime 状态。

## 影响模块

- `packages/opencode/config/protocol/planner-protocol.md`
- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/runs.ts`
- `packages/opencode/src/session/result.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/sdk/`
- `packages/app/src/pages/session/session-runs.tsx`
- `packages/app/src/i18n/`
- `docs/harness-module/`

实现时先复用现有终态协议解析和 SessionResult 读取函数。只有现有协议结构无法无歧义表达“上一 Run 的结果，同时创建下一 Run”时，才补充最小协议字段；不扩大 DSL 的任务编排能力。

## 验证计划

### Runtime 与持久化

- 澄清、input-only、confirm-only 和普通回复不会创建 Run。
- 一个包含多个 actions 的 DSL 包只创建一个 Run。
- 新的可执行 DSL 包创建新的 Run。
- 父 Run 在模型综合前没有最终 `summary`，综合后持久化正确结果。
- 模型总结上一 Run 并继续分派时，上一 Run 保存结果，新 actions 进入新 Run。
- 缺少上一 Run 结果的继续分派触发协议修复，不写入伪结果。
- 重启后仍能读取父 Run 的最终结果。

### 子会话结果

- 合法 ActionResult 只展示 `action_result.result`，不展示整段 JSON。
- fallback carrier 展示 Markdown output，缺失时回退 canonical summary。
- protocol runner 子会话展示终态协议内容。
- 没有本地 DSL Run 的执行型子会话仍展示委派 Run 和最终交付结果。
- 产生本地 DSL Run 的子会话区分整体委派结果和内部阶段结果。
- result ID 指向其他 session、run 或 action 时拒绝关联。

### API 与界面

- Runs 列表展示多个 DSL 任务包，而不是多个用户澄清 turn。
- 任务内容、最终结果、actions 和文档均可查看。
- 运行中、已完成、失败、阻塞、fallback 和缺失结果状态文案正确。
- Markdown 结果和文档均能安全渲染。
- Session Runs 路由、OpenAPI 和 JavaScript SDK 类型同步更新。

### 命令

- 从 `packages/opencode` 运行 Session Runs、protocol runner、delegation 和 server route 聚焦测试。
- 从 `packages/opencode` 运行 `bun typecheck`。
- 从 `packages/app` 运行 Runs 组件测试和 `bun typecheck`。
- 从 `packages/app` 运行 `bun test:e2e:local -- app/smoke.spec.ts`。
- 运行 `git diff --check`。

## 非目标

- 不把一条用户消息或一个 SessionTurn 直接定义成 Run。
- 不为澄清、补充信息或普通回答创建空 Run。
- 不把父会话中的每个 action 拆成父会话顶层 Run；`agent` action 创建的委派任务只在对应子会话中投影为该子会话的委派 Run。
- 不把 action 状态列表当作最终任务结果。
- 不复制或替换 canonical SessionResult。
- 不依赖有保留期限的 Session Log 保存最终结果。
- 不在本次改动中重新设计全局 Harness v2 Runs。
