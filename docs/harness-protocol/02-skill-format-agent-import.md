# Skill 格式 Agent 导入

Open Agent Harness 可以将 `SKILL.md` 文件导入为虚拟 Agent。Runtime 会把可复用 instruction package 归一化到与手写 Agent 相同的 registry、选择、delegation、permission 和管理界面中。

## 设计理念

Skill 和 Agent 描述的是同一种产品对象的不同编写深度：用于完成特定工作的可复用指令。

Skill 通常从重复 prompt 的快捷方式开始。随着它成熟，会逐渐变成一个可复用 workflow：采用什么身份、遵循什么步骤、遵守什么规则、处理什么异常、产出什么结果。Agent team 从相反方向描述同一结构：把较大的工作拆给专业 Agent，让每个专业 Agent 拥有聚焦 workflow，并由系统委托给合适的 Agent。

产品定位是：这类重叠最终应收敛到 Agent。

Agent 是更强的 runtime 抽象，因为它为可复用 workflow 提供完整执行边界：

- 身份和行为是一等对象。
- 上下文按任务隔离，而不是在同一长会话中累积多个无关 Skill。
- 生命周期明确：为任务创建 Agent 实例，完成任务，然后丢弃该上下文。
- 权限、工具、模型选择、成本和入口行为都可以按 Agent 治理。
- 未来的 memory 或运行历史自然归属于 Agent，而不是无状态 prompt 片段。

这对上下文工程很重要。在同一长会话中调用多个 Skill 会混合无关指令和历史，增加上下文长度、注意力漂移和任务之间的意外污染。把同一个 workflow 作为 subagent 运行，可以让每个工作单元保持聚焦：一个 Agent 实例、一个任务边界、一个干净上下文。

Skill 仍然是低摩擦的编写格式。协议把它们视为一种紧凑的 Agent 定义方式，适用于不需要完整模板的情况。

简言之：Skill 是可接受的编写输入；Agent 是执行模型。

## 原理

核心产品方向是用 Agent 表示可复用行为。单独的 Skill 执行路径会重复 discovery、invocation rules、permissions 和 UI behavior。

导入层保留 `SKILL.md` 的编写便利性，同时让执行保持在 Agent 模型内。导入后，系统会把一个 Skill package 视为带有 metadata、prompt text、entry flags、capability tags 和 permission policy 的 Agent。

## 支持输入

Runtime 扫描受支持 skill roots 中名为以下形式的文件：

```text
*/SKILL.md
```

默认全局 skill root 是：

```text
~/.claude/skills/
```

当提供 Agent 目录 root 时，loader 也可以支持同级 `skill/` 和 `skills/` 目录。主要面向用户的全局路径是 `~/.claude/skills/`。

## 导入规则

每个 `SKILL.md` 都按 Markdown 解析，并允许可选 frontmatter。

导入后的 Agent id 来自：

1. frontmatter 中的 `name`，如果存在。
2. 当 `name` 不存在时，使用 Skill 目录名。

id 会被归一化为小写，可包含字母、数字、点、下划线和短横线。

导入后的 description 来自：

1. frontmatter 中的 `description`，如果存在。
2. 生成的默认 description。

导入后的 prompt 从 Skill body 构造：

- 如果存在来源 identity/persona 章节，则导入为 Agent `persona`。
- 如果存在 `## Workflow` 和 `## Rules`，则成为 Agent rules。
- 如果这些章节不存在，则使用完整 Skill body。

生成的 Agent metadata 使用：

```json
{
  "mode": "subagent",
  "capability": {
    "purpose": "skill_import",
    "tags": ["skill", "<agent-id>"],
    "cost": "medium",
    "writes": true
  },
  "permission_mode": "lax"
}
```

这些 Agent 是虚拟 Agent。Runtime 不会把生成的 `meta.json`、`identity.md` 或 `rules.md` 写回磁盘。

## 优先级

显式 Agent 模板会覆盖相同 id 的导入 Skill。

这允许轻量 `SKILL.md` 逐步演进为完整 Agent 模板，并保持 invocation id 不变。

## Runtime 行为

导入 Skill 会在 `/agent` 中表现为普通 Agent record，包含：

- `name`：导入后的 Agent id
- `mode`：`subagent`
- `capability.purpose`：`skill_import`
- `capability.tags`：`["skill", id]`

除非被 Agent metadata 或配置隐藏，否则它们会出现在 session Agent 选择中。

它们默认可 mention、可 delegation，因为生成的 entry metadata 遵循 subagent 语义。

## Agent 管理 UI

管理 API 将导入 Skill 标记为：

```json
{
  "kind": "skill",
  "editable": false
}
```

这将它们与手写 Agent 区分开：

```json
{
  "kind": "agent",
  "editable": true
}
```

设置 UI 可以按类型过滤：

- 全部
- 手写 Agent
- 导入 Skill

导入 Skill 不能在 Agent Manager 中直接编辑，因为它们的事实来源是 `SKILL.md`。要定制某个 Skill，可以编辑来源 Skill 文件，或创建一个相同 id 的手写 Agent 模板。

## 执行边界

这个导入层把 Skill 统一纳入 Agent runtime。

具体规则：

- 系统不提供独立 `skill` tool。
- 顶层 `skills` 配置不作为执行入口。
- `permission.skill` 配置不作为执行权限模型。
- 导入 Skill 不通过 Skill 专用 dispatcher 执行。

受支持的执行路径是 Agent runtime。

## 已知边界

导入 Skill 会保留主要 prompt 内容和 description，但不会推断丰富 Agent metadata，例如模型偏好、详细工具策略、超过默认值的成本信息或自定义 entry flags。

当 Skill 稳定后，生产级行为应使用手写 Agent 模板表达。
