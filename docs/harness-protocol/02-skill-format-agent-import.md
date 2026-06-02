# SKILL.md 到 Agent 导入

Open Agent Harness 可以将 `SKILL.md` 文件导入为虚拟 Agent。Runtime 会把轻量 instruction package 归一化到与手写 Agent 相同的 registry、选择、delegation、permission 和管理界面中。

本文定义 `SKILL.md` 如何升级为 Agent。导入完成后，Harness 协议中的可调用对象是 Agent，执行实例是 Agent Session。

## 设计理念

`SKILL.md` 是一种低摩擦编写格式，通常用于描述某一类工作应该怎么做：适用场景、执行步骤、判断规则、输入要求、输出格式、质量检查和注意事项。

这类内容和 Agent 的定位有重合。Agent 也表达“专业做某一件事”的可复用能力，但 Agent 是 Runtime 可以治理的执行模板。Agent 模板除了 prompt 材料，还包含入口规则、能力元数据、权限策略、模型偏好和运行策略。

把 `SKILL.md` 升级为 Agent，是为了让这类专业工作说明进入 Harness 的统一治理模型：

- 稳定身份：每个导入结果拥有稳定 Agent id、name 和 description。
- 调用入口：通过 Agent entry 控制它能否作为主会话、mention 对象或 delegation 候选。
- 能力描述：通过 capability 表达它适合处理什么任务，供 routing 和 UI 使用。
- 权限边界：通过 permission profile、assignment authority、用户审批和 gate 决定实际可执行范围。
- 会话隔离：每次执行由 Runtime 创建 Agent Session，并为该 session 构造独立 Context Bundle。
- 状态记录：执行过程进入 Action、Assignment、Event、Projection、Artifact 和 Trace。
- 管理视图：UI 按 Agent record 展示、选择、过滤和审计。

导入协议保留 `SKILL.md` 的编写便利性，但运行时只面对 Agent 模型。`SKILL.md` 是来源文件，虚拟 Agent 是协议对象，Agent Session 是运行实例。

## 导入原理

Runtime 使用同一个 Agent registry 管理手写 Agent 和由 `SKILL.md` 导入的虚拟 Agent。

导入层负责把一个 `SKILL.md` package 转换为 Agent record。转换后的 record 具有：

- 稳定 id
- name
- description
- prompt material
- entry flags
- capability tags
- permission profile
- source reference
- source format metadata

Runtime 后续只处理 Agent record。routing、delegation、permission、session creation、trace 和 UI 都使用 Agent 模型。

## 支持输入

Runtime 扫描受支持 roots 中名为以下形式的文件：

```text
*/SKILL.md
```

默认全局 root 是：

```text
~/.claude/skills/
```

当提供 Agent 目录 root 时，loader 也可以支持同级 `skill/` 和 `skills/` 目录。主要面向用户的全局路径是 `~/.claude/skills/`。

## 导入规则

每个 `SKILL.md` 都按 Markdown 解析，并允许可选 frontmatter。

导入后的 Agent id 来自：

1. frontmatter 中的 `name`，如果存在。
2. 当 `name` 不存在时，使用来源目录名。

id 会按 Agent 命名规范归一化为 `lower_snake_case`，只包含小写字母、数字和下划线。

导入后的 Agent description 来自：

1. frontmatter 中的 `description`，如果存在。
2. 生成的默认 description。

导入后的 prompt material 从 Markdown body 构造：

- identity、persona、职责说明等章节导入为 Agent `persona`。
- 步骤、规则、检查项、输出格式等章节导入为 Agent rules。
- 其他正文作为补充 prompt material 保留。

生成的 Agent metadata 使用：

```json
{
  "entry": {
    "primary": false,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "imported_instruction",
    "tags": ["imported", "<agent-id>"],
    "cost": "medium",
    "writes": true
  },
  "inherit_permissions": false,
  "permission_mode": "lax",
  "source": {
    "format": "markdown_instruction",
    "path": "<source-dir>/SKILL.md"
  }
}
```

生成的 `meta.json`、`identity.md` 或 `rules.md` 只存在于导入结果。磁盘事实来源保持为原始 `SKILL.md` 文件。

## 优先级

显式 Agent 模板会覆盖相同 id 的导入结果。

这允许轻量 `SKILL.md` 逐步升级为完整 Agent 模板，并保持 invocation id 不变。

## Runtime 行为

由 `SKILL.md` 导入的对象在 `/agent` 中表现为普通 Agent record，包含：

- `name`：导入后的 Agent id
- `entry`：`{ "primary": false, "delegable": true, "mentionable": true, "default": false, "hidden": false }`
- `capability.purpose`：`imported_instruction`
- `capability.tags`：`["imported", id]`
- `source.format`：`markdown_instruction`

当 Agent metadata 或配置没有隐藏该记录时，它们会出现在 session Agent 选择中。

它们默认可 mention、可 delegation，因为生成的 entry metadata 将其定位为可委托 Agent。

当 Runtime 选择该 Agent 执行工作时，运行链路与普通 Agent 一致：

```txt
Action
  -> routing selects Agent
  -> Runtime creates Agent Session
  -> Runtime builds Context Bundle from assignment and imported prompt material
  -> model produces protocol output
  -> Runtime records Event, Artifact, Projection and Trace
```

Agent Session 的 session log 持久记录该 session 中被 Runtime 接受和引用的消息、协议输出、Action、observation、Artifact ref 和状态变化。

Context Bundle 由 Runtime 在每次模型调用前构造，包含 assignment contract、导入的 prompt material、相关 Projection、Artifact、约束、环境信息和必要的语义解释。

## Agent 管理 UI

管理 API 按 Agent record 返回导入结果：

```json
{
  "kind": "agent",
  "editable": false,
  "source": {
    "format": "markdown_instruction"
  }
}
```

设置 UI 可以按来源过滤：

- 全部 Agent
- 手写 Agent
- 由 `SKILL.md` 导入的 Agent

由 `SKILL.md` 导入的 Agent 在 Agent Manager 中以只读记录展示，因为它们的事实来源是原始 Markdown 文件。要定制某个导入结果，可以编辑来源文件，或创建一个相同 id 的手写 Agent 模板。

## 协议边界

`SKILL.md` 导入层把 Markdown 来源文件映射为 Agent runtime 可消费的模板记录。协议边界如下：

- 来源文件是 `SKILL.md`。
- 导入结果是虚拟 Agent record。
- 执行实例是 Agent Session。
- 权限由导入 metadata、Agent permission profile、assignment authority、用户审批和 Runtime gate 共同决定。
- 状态记录进入 Harness Event、Projection 和 Trace。
- UI 以 Agent record 展示其可调用能力，并通过 `source.format` 标记来源。

受支持的执行路径是 Agent runtime。

## 升级边界

导入层会保留主要 prompt 内容、description 和可识别的结构化章节，并生成基础 metadata。

需要精细治理时，应使用手写 Agent 模板表达更完整的字段，例如：

- 明确的 `entry`
- 细分的 `capability.purpose`
- 更准确的 `capability.tags`
- `model_preference`
- `allowed_tools` / `denied_tools`
- `permission_mode`
- `orchestration_policy`

`SKILL.md` 适合快速描述一项工作的步骤和规则；Agent 模板适合表达可治理、可路由、可观测、可授权的执行身份。
