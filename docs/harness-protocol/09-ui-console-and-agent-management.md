# UI 控制台与 Agent 管理

## 目的

Harness UI 的目标是让用户管理、观察和使用 Harness 系统。UI 不从自然语言 transcript 推断状态，而是读取 Runtime Projection，并把用户操作提交为 Command 或受控 Action。

UI 由三个主要 surface 组成：

- **Harness Console**：管理 Run、Task、Assignment、Artifact、Gate、Decision、Event、Trace、Memory、Concept。
- **Session Tree Workbench**：把 root session、child session、descendant session 展示成可导航树。
- **Agent Manager**：管理 Agent 模板、entry、capability、permission、启用状态和 authoring 内容。

## 设计边界

- 主聊天界面和 Harness Console 是两个独立 surface。
- 前端不直接修改状态文件、数据库或 projection。
- 所有状态变化都通过 Runtime Command、受控 Action 或 adapter API。
- UI 以 Projection 为主要数据源，Event Log 和 raw trace 作为审计入口。
- UI 视图、Artifact 摘要和 Trace export 使用稳定 id、状态、summary、refs、evidence、actor、time 和 visibility metadata，让人类和 Agent Session 都能读取和复用。
- Project Memory 位于 project-local Harness store；Team/Global Memory 通过 Memory Service 引用。
- Provider/model settings、worktree/sandbox settings 是独立配置 surface。
- Working directory 是 runtime project boundary；UI 不引入面向用户的 `workspaceID`。

## 核心对象

Harness Console 必须能展示这些对象：

- `Run`
- `Task`
- `Assignment`
- `Agent Session`
- `Artifact`
- `Gate`
- `Decision`
- `Event`
- `Trace`
- `Memory`
- `Concept`

## 架构

```txt
主聊天界面
  -> session/message/tool API

Harness Console
  -> Harness API
  -> Harness Runtime
  -> Command/Event/Projection/Gate
  -> run-scoped store + governance store

Session Tree Workbench
  -> session tree API
  -> root/child/descendant session projection

Agent Manager
  -> agent management API
  -> package/user/project agent templates

共享底层
  -> provider / tool / workspace / storage / permission
```

## Harness 控制台

### 只读 Console

目标：用户可以在不执行操作的情况下检查结构化 Harness 状态。

后端：

- 为 Run、Task、Assignment、Artifact、Decision、Event 和 Projection envelope 定义 read schema
- 读取 `.opencode/harness/runs/<run>/...`
- 当 Harness data 不存在时返回空列表
- 暴露读取路由：
  - `GET /harness/runs`
  - `GET /harness/runs/:id`
  - `GET /harness/runs/:id/tasks`
  - `GET /harness/runs/:id/assignments`
  - `GET /harness/runs/:id/artifacts`
  - `GET /harness/runs/:id/decisions`
  - `GET /harness/runs/:id/events`

前端：

- 增加独立 Harness Console 路由
- 展示 Run list、Run detail、Task list、Artifact list、Decision list、Event list
- 清晰展示 loading、empty 和 error states
- 展示 Projection source 和 update time

验收：

- 用户可以看到 run status、blockers、evidence 和 pending decisions
- UI 不解析聊天文本来推断状态
- Harness store 缺失时展示合法 empty state

### 可操作 Console

目标：用户可以通过受控操作推进 Run。

Command 类型：

- `run.create`
- `run.pause`
- `run.resume`
- `run.abort`
- `task.retry`
- `task.cancel`
- `decision.answer`
- `verify.rerun`

后端：

- 定义 Command schema 和所需 authority
- 校验 schema、authority、gate conditions 和 run mutability
- 更新 Projection 前追加 Event
- 返回更新后的 Projection summary
- 暴露 command route，例如 `POST /harness/commands`

前端：

- 提供 create Run form
- 提供 pause/resume/abort controls
- 提供 task retry/cancel controls
- 将 Decision Request 渲染为人类可读选项
- 展示 Gate rejection reason，并且不在 accepted projection 之外乐观改变 client state

验收：

- 所有 UI 操作都变成 Command 或受控 Action
- completed run 不能任意 resume
- non-pending decision 不能 answer
- failed command 不产生 half state

### 治理 Console

目标：用户可以检查 governance state、authority、memory 和 concept changes。

能力：

- 跨 `run`、`project`、`team` 和 `global` 的 Memory Query
- Project/Team/Global Memory scope display
- Concept Detail
- Concept Replacement Request
- Impact Scan
- Authority View
- Gate Detail

规则：

- 当前 Projection 覆盖 historical memory
- Concept replacement 需要 `new_information`
- replacement request 必须展示 impacted refs、evidence、owner 和 gate result
- Authority View 必须区分 capability 和 granted authority

验收：

- 用户可以看到 concept 为什么 active、superseded 或 historical
- 用户可以看到 concept replacement 影响哪些 task 或 file
- 当缺少必要 evidence 时，UI 阻塞 concept replacement

### 可视化与审计

目标：用户可以检查复杂 run 并导出 audit evidence。

视图：

- Task Graph
- Concept Graph
- Event Explorer
- Projection Rebuild debug entry
- Run Comparison
- Audit Export

规则：

- graph views 是 projection，不是 state source
- raw JSON 可用于检查，但不是主要体验
- audit export 遵守 redaction policy
- projection rebuild 是 debug action，并需要适当 authority

验收：

- 用户可以追踪 Command -> Event -> Projection
- 用户可以按 duration、status、action count、tool calls 和 failure reasons 对比 run
- 用户可以导出已应用 redaction 的 audit material

## Session 树工作台

目标：nested session 是一等交互对象。

预期行为：

- sidebar/session navigation 渲染 root sessions、child sessions 和更深 descendants
- child session 一致展示 status、pending permission/question indicators、unread/error state 和 Agent tint
- parent session view 清晰暴露 child sessions
- 打开任意 child session 都路由到 `/:dir/session/:id`
- 除非 Runtime 报告 blocking state，否则 child 和 descendant sessions 保持可交互
- 删除或归档 parent 时，对 descendants 的处理可预测

实现任务：

- 在 directory guard 下增加 recursive session descendants/tree query
- route shape 变化后重新生成 SDK
- root session list 后加载 descendant sessions，并合并到 directory store
- 为保留的 root 保存完整 descendant closure
- 构建支持 active-lineage expansion 的 recursive session tree renderer
- 调整 sidebar prefetch/nav order 到 flattened visible tree
- 测试 child/grandchild rendering、navigation 和 prompt submission isolation

## Agent 管理器

目标：用户可以把 Agent 作为受治理 runtime object 管理。

预期行为：

- Settings 包含 Agents tab
- 列出 Agent 的 source、persona、entry flags、capability、permission mode、enabled state、diagnostics
- 创建 user/project Agent 模板
- 编辑 metadata、identity/rules content、model defaults、entry flags 和 custom permissions
- disable 或 re-enable Agent，而不删除其 config
- package/builtin templates 可见，但不能原地修改
- disabled Agent 仍在 Agent Manager 中可见，并从普通 picker 和 `@agent` suggestions 中消失

实现任务：

- 为 package/user/project sources、disabled state、diagnostics、identity 和 rules 定义 management schema
- 增加 list/get endpoints，包含 disabled Agent
- 为 user/project templates 增加 validate/create/update endpoints
- 使用 config overlay 语义增加 enable/disable endpoint
- route shape 变化后重新生成 SDK
- 增加 WebUI API helpers/context，用于 Agent 管理
- 为 `meta.json`、`identity.md`、`rules.md`、entry flags、model defaults 和 permissions 增加 create/edit form
- 主 picker 切换为使用 `entry.primary`
- `@agent` suggestions 切换为使用 `entry.mentionable`
- 以确定性 replacement 处理禁用当前选中 Agent 的情况

验收：

- `/agent` 风格 runtime selection 隐藏 disabled Agent
- management list 包含 disabled Agent，并带 source 和 diagnostics
- form validation 在写入前捕获无效 template metadata
- picker 和 mention tests 覆盖 primary、mentionable、hidden 和 disabled 组合

## Protocol Run 面板

Protocol run 应可见，但默认不暴露 raw logs。

要求：

- 只有存在 protocol run metadata 或 protocol logs 时才展示 Protocol tab
- 展示 run title、status、action graph list、selected action detail、executor、summary、artifacts 和 block/failure reason
- 暴露完整 protocol trace JSON 的 view/copy/export
- 当可用时展示 comparison metrics：direct toolCall count、protocol action count、internal tool calls、model-visible bytes、raw output bytes、duration
- 保持 Protocol 与 Workflow、Logs、Review、file 和 context tabs 区分

## 测试策略

- Harness read/command routes 的 API contract tests
- Command -> Event -> Projection chain tests
- Decision Answer、Task Retry、pause/resume/abort tests
- Harness Console loading、empty、error、list 和 detail states 的 component tests
- recursive rendering 和 child interaction 的 session tree tests
- list/get/create/update/disable/enable 的 Agent manager tests
- action detail 和 export controls 的 protocol panel/log tests
- 从受影响 package directory 运行 package-level typechecks

## 验收摘要

UI 被接受的条件：

- 用户可以独立进入 Harness Console
- 所有可见状态来自 Projection、Event 或 runtime trace APIs
- 所有改变状态的 action 都通过 Runtime
- 用户可以检查 run status、blockers、evidence、decisions、memory、concepts 和 authority
- 用户可以导航 nested sessions，并在 child sessions 中继续工作
- 用户可以管理 Agent，而不需要手动编辑文件
- audit/export flows 遵守 visibility 和 redaction policy
- Artifact、Trace 和 UI projection 对人类和后续 Agent Session 都保持结构化可读
