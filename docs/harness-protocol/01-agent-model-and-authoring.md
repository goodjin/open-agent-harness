# Agent 模型与编写规范

Agent 模板存放在 `config/agents/<id>/` 下，包含 `meta.json`，并可选包含 `identity.md` 和 `rules.md`。`<id>` 目录名必须与 `meta.json.id` 一致；package 模板和用户模板合并后，所有 id 必须唯一。

本文定义 Harness 的 Agent 编写协议。Agent 是可复用模板，包含入口规则、能力元数据、prompt 材料、模型偏好和权限策略。具体工作需要执行时，Runtime 从模板创建 Agent Session。

Runtime 将 package、user、project 三类模板加载到同一个 registry 中。相同 id 的后加载模板覆盖先加载模板。无效模板产生诊断信息，但不阻止有效模板加载。

Harness 区分三类信息：

- `entry`：Agent 可以从哪里被调用。
- `capability`：Agent 适合做什么。
- `permission`：Agent 在某个具体 assignment 中实际可以做什么。

## Agent 模板与 Agent Session

Agent 模板本身不执行 assignment。Runtime 从 Agent 模板创建 Agent Session，将 assignment authority 绑定到该 session，并把 session 记录为 run trace 的一部分。

一个 Agent Session 包含：

- 稳定的 session id
- 来源 Agent 模板 id
- assignment 或 root run 关系
- session log
- 生效 authority
- trace refs
- status

Session log 是与该 session 相关的已接受消息、协议输出、Action、Observation、Artifact refs 和状态变更的持久记录。

Model context 与 session log 不是同一个对象。每次模型调用前，Runtime 根据 session log、当前 Projection、相关 Memory、Artifact refs、环境信息、约束和语义解释提示构造 Context Bundle。

## 必填字段

- `id`：稳定模板 id。使用与目录名相同的值。会裁剪空白字符，空值会被拒绝。
- `name`：展示名称。会裁剪空白字符，空值会被拒绝。
- `persona`：用于 prompt 构造的简短行为契约。会裁剪空白字符，空值会被拒绝。
- `description`：面向用户的摘要。会裁剪空白字符，空值会被拒绝。

## 可选字段与默认值

- `model_preference`：`{ "providerID": "...", "modelID": "..." }`。当 provider/model catalog 可用时，两个 id 都必须存在。
- `mode`：粗粒度 entry preset 的导入别名。公开协议输出应暴露解析后的 `entry`。
- `hidden`：默认 `false`。
- `workflow_mode`：默认 `auto`。
- `allowed_tools`：默认 `[]`。
- `denied_tools`：默认 `[]`。
- `inherit_permissions`：默认 `true`。
- `permission_mode`：默认 `strict`。

## Entry 模型

`entry` 是 Agent 可被使用位置的事实来源。它刻意与权限和调度质量分离。

```json
{
  "entry": {
    "primary": true,
    "delegable": true,
    "mentionable": true,
    "default": true,
    "hidden": false
  }
}
```

字段含义：

- `primary`：可以作为主会话 Agent 运行，并出现在主 Agent 切换器中。
- `delegable`：可以被任务/委托机制启动。
- `mentionable`：可以通过用户 mention 或自动补全直接调用。
- `default`：可以被默认 Agent 解析逻辑选中。
- `hidden`：即使其他 entry flag 为 true，也不应出现在常规用户选择器中。

当 loader 收到粗粒度 `mode` 别名时，会解析成显式 entry flags：

- `primary`：`{ "primary": true, "delegable": true, "mentionable": true, "default": true, "hidden": false }`
- `subagent`：`{ "primary": false, "delegable": true, "mentionable": true, "default": false, "hidden": false }`
- `all`：`{ "primary": true, "delegable": true, "mentionable": true, "default": true, "hidden": false }`

如果同时存在 `entry` 和 `mode`，以 `entry` 为准。Runtime API 应返回解析后的 entry flags，让 UI、routing 和 delegation 不需要解释别名。

选择规则：

- 主 Agent 切换器：`entry.primary && !entry.hidden`
- mention 自动补全：`entry.mentionable && !entry.hidden`
- delegation 候选：`entry.delegable && !entry.hidden`
- 默认 Agent 资格：`entry.primary && entry.default && !entry.hidden`

## Capability 模型

`capability` 描述 Agent 擅长什么。Dispatcher 和 prompt builder 应结合这些元数据与 `description` 判断何时委托，而不是依赖 `mode`。

```json
{
  "capability": {
    "purpose": "architecture_review",
    "tags": ["architecture", "debugging", "review"],
    "cost": "high",
    "writes": false
  }
}
```

字段含义：

- `purpose`：简短稳定的 routing hint。
- `tags`：用于 prompt 生成和 dispatch table 的可搜索能力标签。
- `cost`：相对执行成本，取值为 `low`、`medium` 或 `high`。
- `writes`：声明式元数据，表示该 Agent 是否预期会修改 workspace 状态。

`capability.writes` 是元数据，不是权限 enforcement。实际写入权限仍来自 permission policy。

## Workflow 模式

`AgentTemplate.workflow(meta)` 根据所选模式返回 runtime behavior object：

- `auto`：`{ "autonomous": true, "prompt": false, "review_tools": false, "review_state": false }`。运行常规自主 prompt loop。
- `manual`：`{ "autonomous": false, "prompt": true, "review_tools": true, "review_state": true }`。在执行实质操作前等待明确用户指令。
- `supervision`：`{ "autonomous": true, "prompt": false, "review_tools": true, "review_state": true }`。可以自由计划和检查，但工具使用和状态变更工作需要升级审查。

## Permission 模式

`AgentTemplate.permission(meta)` 根据所选模式返回可消费的 permission profile：

- `strict`：policy 为 `inherit`；当 `inherit_permissions` 为 true 时继承项目默认值，忽略 `allowed_tools`，并应用 `denied_tools`。
- `lax`：policy 为 `allow`；当 `inherit_permissions` 为 true 时继承默认允许行为，忽略 `allowed_tools`，并应用 `denied_tools`。
- `custom`：policy 为 `custom`；使用 `allowed_tools` 和 `denied_tools` 作为作者定义的 permission profile，是否继承由 `inherit_permissions` 控制。

## 最小模板

```json
{
  "id": "coder",
  "name": "Coder Agent",
  "persona": "Write and verify focused code changes.",
  "description": "A coding agent for implementation tasks."
}
```

## 完整模板

```json
{
  "id": "reviewer",
  "name": "Reviewer Agent",
  "persona": "Review code for correctness, regressions, and missing tests.",
  "description": "A review agent for high-signal code review.",
  "entry": {
    "primary": false,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "code_review",
    "tags": ["review", "correctness", "tests"],
    "cost": "medium",
    "writes": false
  },
  "model_preference": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514"
  },
  "workflow_mode": "supervision",
  "allowed_tools": ["read", "grep", "bash"],
  "denied_tools": ["edit"],
  "inherit_permissions": true,
  "permission_mode": "custom"
}
```

## 内置 Agent Entry

内置 Agent 应使用以下 entry/capability 形态：

| Agent | Entry | Capability |
|---|---|---|
| `build` | primary、delegable、mentionable、default | implementation；writes true；cost medium |
| `plan` | primary、delegable、mentionable、not default | planning and analysis；writes false；cost low |
| `general` | not primary、delegable、mentionable | general research and bounded work；writes true；cost medium |
| `explore` | not primary、delegable、mentionable | code search and pattern discovery；writes false；cost low |
| `compaction` | hidden、not delegable、not mentionable | system compaction；writes false；cost low |
| `title` | hidden、not delegable、not mentionable | system title generation；writes false；cost low |
| `summary` | hidden、not delegable、not mentionable | system summary generation；writes false；cost low |
| `sisyphus` | primary、delegable、mentionable、default candidate | orchestration and implementation oversight；writes true；cost high |
| `workflow-runner` | primary、delegable、mentionable、not default | durable workflow DAG orchestration and recovery decisions；writes true；cost high |
| `hephaestus` | primary、delegable、mentionable | deep autonomous implementation；writes true；cost high |
| `prometheus` | primary、delegable、mentionable | plan building；writes markdown/plans only by convention；cost high |
| `atlas` | primary、delegable、mentionable | plan execution and coordination；writes true；cost high |
| `sisyphus-junior` | not primary、delegable、mentionable | focused delegated execution；writes true；cost medium |
| `oracle` | not primary、delegable、mentionable | architecture and technical advice；writes false；cost high |
| `librarian` | not primary、delegable、mentionable | external docs and source research；writes false；cost low |
| `metis` | not primary、delegable、mentionable | pre-planning consultation；writes false；cost medium |
| `momus` | not primary、delegable、mentionable | plan review；writes false；cost medium |
| `multimodal-looker` | not primary、delegable、mentionable | media interpretation；writes false；cost low |

## 实现要求

1. Schema 校验 `entry` 和 `capability`，包括默认值。
2. Loader 在存在 `mode` 别名时将其解析为显式 `entry` flags。
3. Registry 和 `/agent` 返回 `entry` 与 `capability`。
4. 默认 Agent 选择使用 `entry.primary`、`entry.default` 和 `entry.hidden`。
5. UI 和自动补全过滤使用相互独立的 entry flags。
6. Delegation 候选生成使用 `entry.delegable` 和 `capability`。
7. 内置 `meta.json` 文件声明 `entry` 和 `capability`。
8. 测试覆盖 schema parsing、alias resolution、default-agent rejection、UI/list filtering、mention filtering 和 delegation candidate filtering。

验证：

- 在 `packages/opencode` 下运行 `bun typecheck`。
- 在 `packages/opencode` 下运行 `bun test test/agent --timeout 30000`。
- 为任何受 entry filtering 影响的 TUI/server 文件增加聚焦测试。
- 如果 `/agent` OpenAPI shape 变化，使用 `./packages/sdk/js/script/build.ts` 重新生成 JavaScript SDK。
