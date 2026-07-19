# 会话单任务、任务修订与 Handoff 设计

## 状态

设计已实现并完成整体验收。当前实现以 SQLite Task/Revision/Handoff 为持久化真相源，保留 Runs 兼容读取，并通过后端领域、服务端、SDK、前端单元与应用 smoke 验证。

旧 Run 懒迁移使用会话级内核文件锁与原子 JSON 发布：Task admission 和 Run store 共用同一锁边界，避免 1→2 Run 并发绕过确认；崩溃留下的 dirty、截断 sidecar 会自动重建，无法解析的旧主 Run 会隔离为诊断文件而不阻塞后续读取。Darwin、Linux 使用 `flock`，Windows 使用 `CreateFileW + LockFileEx`。

本设计调整 `docs/features/2026-07-14-session-runs-task-result-semantics.md` 中“一个会话可展示多个顶层 Run”的产品语义。实现完成后，Task 成为会话中唯一的顶层执行概念，Run 不再作为独立用户概念展示。现有 Run、Action、SessionResult 和 delegation 数据可作为任务版本的内部执行记录继续复用。

## 用户目标

每个会话只能执行一个任务。会话生成首个任务后仍可正常对话，但不能直接创建第二个任务：

- 同一任务的需求变化走任务修订流程；
- 新任务通过 Handoff 交给 Runtime 创建的平级会话；
- 当前任务、执行进度和最终结果在会话主区域中集中展示；
- 旧任务版本归档，默认不展示，通过“查看历史”按需查看。

该限制约束任务生成和执行，不限制普通对话。解释、澄清、进度询问、方案讨论、结果复盘和其他不创建任务的回复保持现有行为。

## 已确认决策

1. 一个 Session 最多绑定一个稳定 `task_id`。
2. Task 与 Run 对外合并。UI、公开 API 和模型提示词只把 Task 作为顶层执行概念。
3. Runtime 内部仍保存 action 图、子会话、结果和恢复数据，但这些数据归属于 Task Revision，不作为独立顶层 Run 展示。
4. 首个可执行任务被 Runtime 接受时绑定 Task。之前的需求澄清和确认不绑定任务。
5. 任务绑定后仍可正常对话。只有模型准备创建或修改可执行任务时，才判断与当前任务的关系。
6. 同一任务发生变化时，模型先查询执行状态并生成修改提议；用户确认后停止旧版本的非终态子会话，归档旧版本，再启动新版本。
7. 新任务不能在当前会话执行。模型生成 Handoff 提议，用户确认后由 Runtime 创建平级会话并开始执行。
8. 默认任务页只展示当前版本。旧版本通过“查看历史”进入只读页面，不能恢复执行。
9. Handoff、任务版本和执行状态使用持久化记录，不依赖普通聊天文本或 `dsl_context` 作为唯一真相源。

## 领域模型

### Session Task

Session Task 是会话唯一的任务身份。一个会话没有任务或只有一个任务，`session_id` 与 `task_id` 一一对应。

任务首次绑定后，以下身份保持稳定：

- `task_id`
- 所属 `session_id`
- 来源类型：用户创建、父会话委派或 Handoff
- 来源关联：来源消息、父会话 action 或 Handoff

任务标题、需求正文、验收标准、工作流和结果属于版本内容，可以更新。

### Task Revision

Task Revision 是一次任务定义。任务正文在版本激活后不再改写；当前版本的 action 状态和结果会随执行推进，被替换后冻结为只读归档快照。

每个版本包含：

- 结构化 Markdown 任务正文；
- 版本号和前一版本；
- 创建原因和来源消息；
- action 图及其执行状态；
- 关联子会话；
- 已完成、partial、failed 和 fallback 结果；
- 任务最终结果；
- 归档时间和归档原因。

同一版本内，模型为了完成当前任务继续追加验证、审查或收口 action，不生成新的顶层 Task 或 Run。这些 action 继续归入当前版本的内部工作流，执行投影同步更新。只有任务正文或工作流边界被重新定义时，才创建新 Revision。

### Child Session

子会话同样遵守一会话一任务。父任务的一个 agent action 创建子会话后，该 action 的完整任务要求成为子会话的唯一 Task。

子会话不能在完成或停止后换任务复用。父任务修订导致旧 action 失效时，旧子会话进入终态并保留结果；新版本需要执行相关工作时创建新的子会话。

### Task Handoff

Task Handoff 表示新任务从当前会话转交到平级会话。它不是父子委派，也不复用当前任务身份。

Handoff 记录包含：

- 来源会话和来源消息；
- 来源任务；
- 新任务标题和 Markdown 正文；
- 必要上下文引用；
- 用户确认状态；
- 目标平级会话和目标任务；
- 创建、启动、失败和重试信息。

目标会话的层级规则为：

```text
target.parent_id = source.parent_id
```

根会话发起 Handoff 时创建新的根会话；子会话发起 Handoff 时，目标会话与来源会话拥有相同父会话。

## 行为设计

### 普通对话

任务绑定不会锁住输入框，也不会把会话改成只读状态。模型可以继续：

- 回答与当前任务有关的问题；
- 解释实现和结果；
- 汇报进度；
- 澄清用户补充的信息；
- 讨论潜在修改；
- 复盘已完成任务；
- 识别并提出 Handoff。

普通文本回复不修改任务，不创建 Task Revision，也不创建 action。

### 首次创建任务

当前会话没有 Task，且模型准备输出至少一个可执行 action 时：

1. 模型生成完整任务 Markdown 和 action 图。
2. Runtime 创建 Session Task。
3. Runtime 创建 Revision v1 并设为当前版本。
4. Runtime 创建 action 和需要的子会话。
5. UI 中的任务按钮从“尚未生成”切换为“执行中”。

input-only、confirm-only、普通回答和纯澄清不创建 Task。

### 修改当前任务

模型判断用户请求仍服务于当前任务，但会改变任务内容或工作流边界时，执行以下流程：

1. 查询当前 Task、Revision、action、子会话和已有结果。
2. 生成任务修改提议，说明：
   - 修改后的任务理解；
   - 与当前版本的差异；
   - 受影响的子会话；
   - 可以复用的已完成成果；
   - 推荐的新工作流。
3. UI 展示“确认修改”“继续讨论”“取消”。
4. 用户确认后，Task 进入 `revising`。
5. Runtime 冻结旧版本，不再派发新 action。
6. 模型使用受控工具停止所有非终态子会话，并等待结果收口。
7. Runtime 保存 completed、partial、failed、fallback 和终止原因。
8. 旧版本归档，不再执行或自动恢复。
9. Runtime 激活新版本，按新的 action 图创建子会话并继续执行。

已完成、失败、取消和归档的子会话不重复停止。旧版本中仍有效的成果可以作为新版本的上下文引用，但旧 action 和旧子会话不能直接改写后继续运行。

### 识别新任务

模型准备创建可执行任务时，如果判断请求不属于当前 Task：

1. 不在当前会话生成新的 action 图。
2. 生成 Task Handoff 提议。
3. UI 说明该请求将进入新的平级会话，并展示新任务正文和上下文范围。
4. 用户选择“创建并执行”“继续讨论”或“取消”。
5. 用户确认后，Runtime 创建平级 Session、Task 和 Revision v1。
6. 目标会话启动任务。
7. 来源会话展示“已转交”记录和跳转链接。

模型错误地在已绑定会话再次创建任务时，Runtime 返回结构化 `session_task_conflict`，拒绝执行并要求模型改用 Task Update 或 Task Handoff。

## 模型提示词与受控能力

### Current Task 上下文

每次调用主模型时，Runtime 注入紧凑的当前任务上下文：

```md
## Current Session Task

- Task ID: task_xxx
- Version: 3
- Status: running
- Title: 限制每个会话只执行一个任务
- Normal conversation remains allowed.
- Modify this task through TaskUpdate.
- Send a different task through TaskHandoff.
```

模型需要完整任务内容或执行细节时，使用查询能力读取，避免每轮把全部版本、action 和历史结果塞入上下文。

### 模型判断规则

System prompt 明确以下顺序：

1. 普通对话直接回答。
2. 准备生成可执行任务时，检查当前会话是否已有 Task。
3. 没有 Task 时创建首个任务。
4. 有 Task 且属于同一目标时，继续当前版本或提出任务修改。
5. 有 Task 且属于新目标时，提出 Handoff。
6. 归属不清时先询问用户，不猜测、不执行。

不增加独立的分类模型调用。任务归属由当前会话主模型在正常响应中判断。

### 受控能力

模型获得四类能力：

- `TaskInspect`：读取当前版本、action、子会话、状态、结果和可复用成果。
- `SessionControl`：停止指定或全部非终态子会话，等待终态，读取 ActionResult 或 fallback。
- `TaskUpdate`：提交任务修改提议和新任务 Markdown；确认、归档和激活由 Runtime 控制。
- `TaskHandoff`：提交新任务提议；用户确认后由 Runtime 创建平级会话。

工具名称是设计占位，实施计划可以在不改变语义的前提下复用现有 DSL item、Session Tree 控制接口和 confirm 机制。

## 持久化设计

### 权威记录

新增三组持久化记录。

#### `session_task`

一个会话最多一条：

- `id`
- `session_id`，唯一索引
- `title`
- `status`
- `current_revision_id`
- `source_type`
- `source_ref`
- `time_created`
- `time_updated`

Task 状态至少覆盖：`running`、`waiting_user`、`revising`、`blocked`、`completed`、`failed`。会话没有任务时不创建空 Task 记录。

#### `task_revision`

- `id`
- `task_id`
- `version`，在 Task 内唯一
- `previous_id`
- `status`
- `body`，结构化 Markdown
- `body_hash`
- `source_message_id`
- `reason`
- `workflow`，内部 action 图及关联元数据
- `result`
- `result_source`
- `time_created`
- `time_activated`
- `time_completed`
- `time_archived`
- `archive_reason`

Revision 状态至少覆盖：`draft`、`active`、`completed`、`failed`、`archived`。同一 Task 最多一个 `active` Revision。

`SessionResult` 继续作为子会话 ActionResult 和 fallback 的 canonical truth。Revision 只保存关联和面向任务的聚合结果，不复制后覆盖 canonical payload。

#### `task_handoff`

- `id`
- `source_session_id`
- `source_task_id`
- `source_message_id`
- `target_session_id`
- `target_task_id`
- `title`
- `body`
- `body_hash`
- `context_refs`
- `status`
- `dedupe_key`
- `error`
- `time_created`
- `time_confirmed`
- `time_completed`

Handoff 状态至少覆盖：`proposed`、`confirmed`、`creating`、`started`、`failed`、`cancelled`。

### Markdown 文档投影

数据库保存权威 Markdown 正文。Runtime 同时把当前和历史版本投影到项目目录：

```text
.harness/
  sessions/<session-id>/
    tasks/<task-id>/
      manifest.md
      revisions/
        v1/task.md
        v2/task.md
```

文档供 Agent 阅读、人工查看和归档。数据库中的 `body_hash` 用于检测文件漂移。`.harness` 文件缺失或损坏时可以从数据库重新生成，不能用被修改的投影文件静默覆盖数据库版本。

### Handoff 保存位置与模型上下文

Handoff 不只保存在聊天文本中：

- `task_handoff` 是来源与目标关系的权威记录；
- 来源会话时间线渲染一张 Handoff 卡片；
- 来源模型上下文只注入简短记录，例如目标任务、目标会话和状态；
- 新任务的完整正文不长期进入来源任务上下文；
- 目标会话启动时读取完整 Handoff 正文，创建自己的 Task 和 Revision v1。

普通消息可以保留用户提出新任务和模型提出 Handoff 的对话，用于解释发生了什么，但消息不是创建关系、目标会话或执行状态的真相源。

## 一致性与事务边界

### 首次创建

Task、Revision v1 和当前版本指针在同一数据库事务中创建。action 和子会话创建失败时，Revision 保持可恢复状态，不能生成第二个 Task。

### 任务修订

1. 修改提议先保存为 `draft` Revision。
2. 用户确认后把 Task 标记为 `revising`，旧 active Revision 暂时保持当前读取版本。
3. 停止旧子会话并保存结果。
4. 在一个事务中归档旧 Revision、激活 draft Revision、更新 `current_revision_id`。
5. 事务完成后启动新 action。

该顺序避免会话在停止子任务期间失去可读的当前任务，也避免两个版本同时 active。

### Handoff

Handoff 使用稳定 `dedupe_key`。用户确认后，Runtime 在事务中创建目标平级 Session、Task、Revision v1 和目标关联，再通过持久化 outbox 启动目标会话。重试只能返回同一个目标会话，不能重复创建。

## API 设计

建议新增以下读取与确认接口：

- `GET /session/:sessionID/task`
- `GET /session/:sessionID/task/history`
- `GET /session/:sessionID/task/revisions/:version`
- `POST /session/:sessionID/task/update/confirm`
- `POST /session/:sessionID/task/handoff/:handoffID/confirm`

Session 列表和 Session Tree 只返回轻量任务摘要：Task ID、标题、版本、状态和进度。完整 Markdown、结果和历史版本按需加载。

现有 Runs API 在迁移期可以作为兼容接口读取内部执行记录。新 UI 和新 SDK 使用 Task API；兼容期结束后再评估是否移除 Runs API，不在首个实现中直接删除。

## UI 设计

### 顶部任务按钮

会话顶部在“对话”和“Logs”附近增加“任务”按钮。原 Runs 按钮由任务入口替代。

按钮显示轻量状态：

- 尚未生成
- 执行中
- 等待修改确认
- 修订中
- 等待用户
- 已完成
- 阻塞
- 失败

按钮不显示历史版本数量，避免主导航变成执行日志入口。

### 当前任务页

点击“任务”后，在会话主区域切换到任务页，不占用右侧文件和日志面板。页面顺序固定为：

1. 当前任务标题、版本、状态和更新时间；
2. 当前任务 Markdown；
3. 当前执行进度和子任务摘要；
4. 当前任务结果；
5. 相关 Handoff。

任务运行中时，结果区显示“当前任务仍在执行”和进度，不把 action 摘要当成最终结果。任务结束后：

- 父级协调任务显示模型 fan-in 后的最终综合结果；
- 子会话任务显示返回父会话的 ActionResult.result；
- 无法生成合法 ActionResult 时显示 fallback，并标明来源；
- 没有可信结果时显示“未记录最终结果”，不拼接日志猜测。

### 查看历史

当前任务页右上角提供“查看历史”。点击后加载归档版本摘要。

历史列表展示：

- 版本号；
- 归档时间；
- 修改原因；
- 当时的终态；
- 已停止子会话数量；
- 是否存在 completed、partial 或 failed 结果。

打开历史版本后显示当时的任务 Markdown、action 快照、停止原因和结果。历史页面只读，不提供“恢复执行”。返回当前任务时重新读取当前版本，避免用旧缓存覆盖新状态。

### 任务修改卡

模型提出修改时，在对话区域展示结构化卡片：

- 修改后的任务标题和摘要；
- 与当前版本的差异；
- 受影响的子会话；
- 可复用成果；
- “查看完整新任务”；
- “确认修改”“继续讨论”“取消”。

确认后，任务按钮和卡片实时展示冻结、停止子会话、收集结果、切换版本和启动新工作流的阶段。

### Handoff 卡

Handoff 卡展示：

- 新任务标题和摘要；
- 为什么不属于当前任务；
- 将复制的上下文范围；
- “创建并执行”“继续讨论”“取消”。

创建成功后，卡片显示目标会话、执行状态和跳转按钮。创建失败时显示安全错误摘要和重试入口，不在当前会话回退执行。

## 失败与恢复

### 子会话无法停止

任务保持 `revising` 或 `blocked`，新 Revision 不得激活。用户可以重试，或使用现有“终止并生成摘要”能力形成 partial handoff。未收口子会话不能与新版本并行继续执行。

### 修改确认后 Runtime 中断

重启时根据 Task 状态、draft Revision、旧 active Revision 和子会话状态恢复：

- 旧子会话仍在运行：继续停止；
- 子会话均终态：完成版本切换；
- 新版本已激活但 action 未启动：幂等启动；
- 状态关联不完整：标记 blocked，等待人工处理，不猜测当前版本。

### Handoff 创建失败

Handoff 保持 `failed` 并记录错误。重试复用 `dedupe_key` 和既有目标会话。来源 Task 不受影响，当前会话不得执行 Handoff 中的新任务。

### 模型绕过规则

Runtime 在执行可执行 DSL 前校验 Session Task：

- 无 Task：允许创建首个任务；
- 有 Task 且是当前版本的 action：允许执行；
- 有 Task 且是已确认的 Task Update：按修订状态执行；
- 有 Task 且缺少更新或 Handoff 关联：拒绝并返回 `session_task_conflict`。

## 旧会话兼容

### 没有历史 Run

视为尚未生成任务，首次可执行任务按新规则绑定。

### 只有一个历史 Run

首次读取当前任务时懒迁移为 Task v1。迁移使用稳定键 `legacy-task:<session-id>:<run-id>`，在一个事务内创建 Task、Revision v1 和当前指针；唯一索引与重放读取保证并发请求不会重复创建 Task 或 Revision。任务正文、action 和结果沿用可信 persisted Run read model；缺少结果时继续显示“未记录最终结果”。

### 存在多个历史 Run

Runtime 不自动判断它们是否属于同一任务。`GET /session/:sessionID/task` 返回 `legacy_multi_run` proposal，会话标记为“旧版会话”，保留现有 Runs 兼容读取。proposal 只包含只读 Run 快照，不带可恢复 action 图，也不写入 Task 或 Revision。

该会话下次准备生成任务时，模型整理一个当前任务提议并请求一次迁移确认。确认后：

- 创建稳定 Task；
- 选定当前 Revision；
- 旧 Runs 作为只读历史执行快照归档；
- 不恢复旧 Run；
- 后续启用严格单任务规则。

首个版本不增加独立的旧会话迁移确认接口。该会话下次准备执行任务时，沿用 create/self assignment 的现有确认链路；Runtime 只接受与当前 package 精确关联的 canonical proposal、message、Run 和 action proof。update、handoff、继承的旧确认和 delegation assignment 都不能完成首次迁移。

`legacy_multi_run` 同时是领域写门禁。Task 绑定入口会重新读取 persisted Runs，不依赖页面是否请求过 proposal。无 canonical create/self proof 的可执行 package 直接返回 `session_task_conflict`，且不写 Task、Revision 或 action。确认与普通执行并发时，以调用进入绑定边界时的 Task 快照判断：确认前进入的普通执行保持拒绝；确认提交后到达的新 action 才能追加到当前 Revision。确认后新 Revision 只包含新执行图，旧 Runs 不进入 workflow。

单 Run 旧会话由所有 Task admission 入口共享迁移，不要求先调用 current API。入口先用有界 key probe 区分 0、1、多个 Run；恰好一个时幂等创建 legacy Task v1，再把新 package 追加到该 Revision。若旧 Revision 已终止，新执行会重新激活它、清除过期结果，并保留旧 action 与 run ID。

多 Run proposal 返回准确总数和最多 50 条首尾快照，超出时标记 `truncated`。SessionRuns 在会话级跨进程锁内维护 generation marker 与 migration manifest；健康轮询只读取这两个固定 key，不枚举主 Run。store 先标记 dirty，再写主 Run 和兼容轻量 index，随后原子发布 manifest 并清除 dirty。manifest 缺失、损坏、dirty 或 generation 不匹配时，会在同一锁内按主 Run 重建。旧 Run 第一次重建时可能单次读取入选的完整主文件，之后轮询保持 O(1)；孤立 index 不参与重建。写门禁仍只探测两个主 key。

新建会话直接使用新模型，不进入旧版兼容路径。

### 已落地的读取边界

Page Feed 负责当前 Task API 的会话级读取与刷新，Task tab 复用这份数据；未打开 Task tab 时也能更新顶部状态。历史列表与历史正文仍按用户操作懒加载，不进入默认 Feed。

Current API 的 OpenAPI 与 JavaScript SDK 使用正常 Task 和 `legacy_multi_run` 的联合类型。前端先判别旧会话 proposal，再渲染 Task 正文、action 和结果，避免把迁移响应误当成 Current Task。

## 影响模块

- `packages/opencode/config/protocol/planner-protocol.md`
- `packages/opencode/config/agents/default/`
- 其他可生成任务的 planner system prompt
- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/result.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/runs.ts`
- `packages/opencode/src/server/routes/session.ts`
- Session recovery、outbox 和 tree control 模块
- `packages/sdk/`
- `packages/app/src/components/session/session-header.tsx`
- `packages/app/src/pages/session.tsx`
- 新的 Task 页面、修改卡和 Handoff 卡组件
- `packages/app/src/i18n/`
- `docs/harness-module/delegation-results.md`
- `docs/harness-module/ui-console.md`

实施时优先复用现有 SessionResult、Assignment、Session Tree 控制、confirm、outbox 和 Runs read model。不要在一个提交中直接删除兼容接口或重写全部 delegation runtime。

## 验证计划

### Task 与 Revision

- 普通对话不会创建或修改 Task。
- input-only、confirm-only 和纯终态回复不会绑定 Task。
- 首个可执行任务只创建一个 Task 和一个 active Revision。
- 同一 Session 并发创建时只能成功一次。
- 同一版本追加 action 不创建第二个顶层 Task。
- 修改任务必须经过用户确认。
- 旧子会话未收口时新版本不能激活。
- 版本切换后旧版本归档且不能恢复执行。
- 崩溃恢复不会产生两个 active Revision。

### Handoff

- 已绑定会话直接创建新任务被 Runtime 拒绝。
- Handoff 未确认时不创建目标会话。
- 确认后创建平级会话。
- 目标会话只绑定 Handoff 任务，不继承来源 Task 身份。
- 重试不会重复创建会话、Task 或 Revision。
- 来源会话只注入紧凑 Handoff 记录。
- 失败 Handoff 不回退到来源会话执行。

### 结果与历史

- 当前任务结果只来自当前 Revision 的可信结果。
- 父任务展示模型综合结果。
- 子任务展示 ActionResult.result 或显式 fallback。
- 历史版本保存当时任务、action、结果和归档原因。
- 默认任务页不加载历史正文。
- 历史详情只读且不能恢复。

### UI、API 与恢复

- 顶部任务按钮状态与后端 Task 状态一致。
- 点击任务按钮在会话主区域展示任务内容、进度和结果。
- 修改确认卡和 Handoff 卡的确认、取消、失败与重试状态正确。
- Handoff 跳转到正确的平级会话。
- Session Task API、OpenAPI 和 JavaScript SDK 类型同步。
- 旧会话的零 Run、单 Run 和多 Run 路径分别验证。
- Runtime 重启后恢复正在修订和正在创建 Handoff 的任务。
- 前端变更通过 `bun test:e2e:local -- app/smoke.spec.ts`。

## 非目标

- 不禁止任务绑定后的普通对话。
- 不为每条消息额外调用一个任务分类模型。
- 不允许一个会话同时执行两个 Task。
- 不允许历史 Revision 恢复执行。
- 不把 Handoff 伪装成父子 delegation。
- 不用 `dsl_context`、Session Log 或普通消息作为 Task、Revision 或 Handoff 的唯一真相源。
- 不在首个实现中立即删除 Runs 兼容 API 和旧数据。
- 不在 Task 页面默认展开全部版本和执行日志。
