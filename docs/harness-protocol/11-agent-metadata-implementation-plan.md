# Agent Metadata RFC 实现方案

Status: Draft

Date: 2026-06-02

Source RFC: `10-agent-metadata-rfc.md`

## 目标

把 Agent metadata 从展示字段扩展为 Runtime 可读取的控制面，同时保持现有 Agent 模板、Agent Manager、SDK 和会话运行路径可用。

第一轮实现不追求一次覆盖 RFC 全部能力。优先让 metadata 能被解析、校验、展示和进入 Runtime 上下文；再逐步让 Runtime 使用它做 completion、artifact validation 和 collaboration expansion。

## 当前基线

当前 Agent schema 位于 `packages/opencode/src/agent/schema.ts`。

现有 `meta.json` 稳定字段：

- `id`
- `name`
- `role`
- `description`
- `model_preference`
- `mode`
- `entry`
- `capability`
- `hidden`
- `runner`
- `workflow_mode`
- `allowed_tools`
- `denied_tools`
- `inherit_permissions`
- `permission_mode`

当前 loader 位于 `packages/opencode/src/agent/loader.ts`，会读取：

- `meta.json`
- `identity.md`
- `rules.md`
- legacy `SKILL.md`

当前管理 API 位于 `packages/opencode/src/agent/manage.ts`，Agent Manager 表单逻辑主要在 `packages/app/src/components/settings-agents-helpers.ts`。

## 设计约束

- 不破坏现有 `meta.json`。
- 不让 metadata 直接授予 authority。
- Agent Session 之间仍不直接通信。
- 新字段先进入 schema、diagnostics、API 和 UI，再逐步进入 Runtime 行为。
- 被运行使用过的 Agent 定义需要可追溯，不能被后续编辑改写历史含义。
- 测试必须从 package 目录运行，不能从 repo root 跑。

## 命名兼容

RFC 使用 `persona`，当前代码使用 `role`。实现上应兼容两者。

建议：

- `role` 暂时保留为内部运行字段。
- `persona` 作为输入别名接受。
- parse 后输出的 `meta.role` 始终存在。
- Agent Manager 可以展示为 Persona，但保存时仍可写 `role`，直到 UI/API 完成迁移。

RFC 使用 `execution_mode` 表示执行行为，当前代码使用 `workflow_mode`。

建议：

- 第一阶段继续保留 `workflow_mode`。
- schema 接受 `execution_mode` 作为别名。
- parse 后输出 `workflow_mode`，避免改动现有 Runtime。
- 后续协议文档再决定是否统一改名。

当前 `inherit_permissions` 默认值是 `true`，RFC 倾向默认 `false`。

建议：

- legacy 模板无 `schema_version` 时保留当前默认 `true`。
- `schema_version: "agent.metadata.v1"` 的模板默认 `false`。
- 这样避免旧模板被静默降权，同时新协议采用更清晰的权限边界。

## Phase 1: Schema 与 Loader 兼容

目标：让新 metadata 能被解析、校验、保存和通过 `/agent` 返回，但不改变 Runtime 行为。

代码改动：

- `packages/opencode/src/agent/schema.ts`
  - 增加 `schema_version`、`agent_version`。
  - 增加 `logo` schema。
  - 增加 `instructions.files` 和 `instructions.model_messages` schema。
  - 增加 `contracts.input` / `contracts.output` schema。
  - 增加 `collaboration.edges` schema。
  - 增加 `runtime_boundary` schema。
  - 增加 `completion` schema。
  - 增加 `lifecycle` schema。
  - 接受 `persona` -> `role` alias。
  - 接受 `execution_mode` -> `workflow_mode` alias。
  - 根据 `schema_version` 决定 `inherit_permissions` 默认值。
- `packages/opencode/src/agent/loader.ts`
  - 加载新字段，不主动执行。
  - 对 `logo.uri` 和 `instructions.files[].path` 做基础诊断。
  - legacy `identity.md` / `rules.md` 继续保留。
- `packages/opencode/src/agent/manage.ts`
  - `Info.meta` 返回新字段。
  - `check/create/update` 使用新 schema 校验。

验收标准：

- 旧 Agent 模板不需要修改也能通过。
- 新 RFC 示例模板能通过 schema parse。
- 非法 path variable、非法 collaboration trigger、非法 completion mode 会产生诊断。
- `/agent` 返回新 metadata。

测试：

- `cd packages/opencode && bun test test/agent/schema.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/agent/loader.test.ts --timeout 30000`
- 如果 OpenAPI shape 变化，运行 `./packages/sdk/js/script/build.ts`。

## Phase 2: Agent Manager 展示与编辑

目标：用户可以看到新 metadata，并能用安全方式编辑 user/project Agent。

代码改动：

- `packages/app/src/components/settings-agents-helpers.ts`
  - 表单 state 支持 `schema_version`、`agent_version`、`logo`。
  - 先用 Advanced JSON 区域编辑 `instructions`、`contracts`、`collaboration`、`completion`。
  - 保留现有基础字段表单。
- Agent Manager UI
  - 展示 logo fallback。
  - 展示 schema version、agent version。
  - 展示 instruction file count、required output count、completion mode、collaboration edge count。
  - 只读 package/builtin agent，新字段同样只读。

验收标准：

- 现有 Agent 表单 round-trip 不丢字段。
- 新 metadata 保存后重新打开仍存在。
- logo 加载失败时 UI 不崩溃。

测试：

- `cd packages/app && bun test --preload ./happydom.ts ./src/components/settings-agents-helpers.test.ts`
- `cd packages/app && bun typecheck`

## Phase 3: Instruction Files 与事件提示

目标：Runtime 能把 `instructions.files` 加入 Context Bundle，并能在特定事件发生时给模型追加受控提示。

代码改动：

- 新增 `packages/opencode/src/agent/instructions.ts`
  - 解析 path variables。
  - 读取 required/optional instruction files。
  - 返回内容、来源、诊断和 trace refs。
- `packages/opencode/src/session/prompt.ts`
  - 构造模型上下文时合并 instruction file 内容。
  - 保留 legacy `identity` / `rules` 注入。
- `packages/opencode/src/session/runner.ts` 或协议运行路径
  - 在 `before_model_call`、`output_validation_failed`、`completion_rejected` 等事件注入 `model_messages`。
  - 事件提示进入 trace，不伪装成用户消息。

路径变量：

- `${agent.dir}`
- `${project.root}`
- `${workspace.root}`
- `${global.rules}`
- `${user.home}`
- `${run.dir}`

验收标准：

- required instruction file 缺失时 Assignment block 或诊断明确。
- optional instruction file 缺失时不阻塞。
- event message 能在 trace 中看到来源。
- event message 不进入用户消息历史伪装成用户输入。

测试：

- `cd packages/opencode && bun test test/session/prompt-runner.test.ts --timeout 30000`
- 增加 `test/agent/instructions.test.ts`。

## Phase 4: Contracts、Artifact 与 Completion

目标：Runtime 不只听模型说 done，而是检查 completion contract。

代码改动：

- 新增 `packages/opencode/src/agent/completion.ts`
  - 输入 assignment/run 状态、metadata completion、artifact index、gate result、unresolved issues。
  - 输出 `completed`、`partial`、`blocked`、`failed`、`waiting_user` 中的建议状态和理由。
- Artifact validation
  - 先支持 required artifact name/type 是否存在。
  - 支持 required evidence 是否存在。
  - `schema_ref` 第一阶段只校验存在和可识别，不执行复杂 schema registry。
- `packages/opencode/src/session/runner.ts`
  - 模型输出 `done` 后调用 completion checker。
  - completion failed 时注入 `completion_rejected` event message，或触发 verifier edge。

验收标准：

- 缺少 required artifact 时不能进入 `completed`。
- 有可用结果但缺验证时进入 `partial`。
- 缺用户输入或审批时进入 `blocked` 或 `waiting_user`。
- completion decision 写入 Event / Trace。

测试：

- 增加 `test/agent/completion.test.ts`。
- `cd packages/opencode && bun test test/session/runner.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/protocol/schema.test.ts --timeout 30000`

## Phase 5: Collaboration Edges

目标：用 `collaboration.edges` 取代单一前置/后置思维，先实现少量高价值触发器。

第一批支持：

- `before_assignment_start` + `kind: "prerequisite"`
- `after_artifact_created` + `kind: "verifier"`
- `on_failed` + `kind: "recovery"`
- `on_conflict` + `kind: "arbiter"`

代码改动：

- 新增 `packages/opencode/src/agent/collaboration.ts`
  - 根据 trigger、when、limits、trace history 选择 edge。
  - 生成标准 Action / Assignment / Handoff。
  - 应用 dedupe、max_depth、max_parallel。
- Routing 路径
  - 目标 Agent 仍通过 `entry.delegable`、capability、availability、budget、permission 过滤。
  - 每个后续 Assignment 独立推导 authority。

验收标准：

- research Agent 可以在执行前触发 web research prerequisite。
- developer Agent 产出 patch 后触发 verifier。
- verifier 失败后可以触发 recovery Agent。
- 冲突结果可以触发 arbiter。
- 循环、重复触发和过深展开被阻止。

测试：

- 增加 `test/agent/collaboration.test.ts`。
- `cd packages/opencode && bun test test/server/agent-manage.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/session/runner.test.ts --timeout 30000`

## Phase 6: Runtime Boundary

目标：权限模型从编程工具扩展到通用资源类别。

第一批资源类别：

- `filesystem`
- `network`
- `browser`
- `secret`
- `personal_data`
- `service`
- `human_contact`

代码改动：

- `packages/opencode/src/agent/schema.ts`
  - 完善 `runtime_boundary` schema。
- permission/routing 路径
  - 将 `runtime_boundary` 转换为 Assignment authority candidate。
  - 高风险动作进入 approval gate。

验收标准：

- 非编程 Agent 可以声明网络、浏览器、邮件、服务等边界。
- metadata 仍不直接授权，最终 authority 来自 Runtime 推导。
- 高风险动作有 blocker reason 和 approval path。

测试：

- 先补 schema 和 routing unit tests。
- 后续根据具体 executor 增加 integration tests。

## Phase 7: Version Snapshot

目标：Agent 更新不改写旧 run 的含义。

代码改动：

- Assignment 创建时记录：
  - `agent_id`
  - `agent_version`
  - `schema_version`
  - `agent_snapshot_hash`
  - `agent_snapshot_ref`
- Snapshot 内容包含参与运行的 normalized meta、identity/rules/instruction refs。
- Agent Manager 更新 active version 时不影响 running session。

验收标准：

- 旧 run trace 能看到当时使用的 Agent snapshot。
- Agent 更新后，新 run 使用新版本，旧 run 仍可回放。
- deprecated Agent 不进入普通 routing，但历史 run 可引用。

测试：

- 增加 snapshot/replay 测试。
- 覆盖 running session 与 updated template 的隔离。

## 推荐 PR 拆分

1. `docs: add agent metadata RFC`
2. `feat(agent): parse metadata control-plane fields`
3. `feat(agent): expose metadata in agent manager`
4. `feat(agent): load instruction files into context`
5. `feat(agent): validate artifacts and completion contract`
6. `feat(agent): expand collaboration edges`
7. `feat(agent): snapshot agent template versions`

## 风险与处理

| 风险 | 处理 |
|---|---|
| 字段太多，评审成本高 | schema 先实现，只展示，不执行。 |
| `role/persona` 与 `workflow_mode/execution_mode` 命名冲突 | 接受别名，内部先不大规模迁移。 |
| 新权限默认值影响旧 Agent | legacy 保持当前默认，v1 新模板使用新默认。 |
| event message 被误认为用户输入 | trace 中标注 runtime event，不写成 user message。 |
| completion 误判 | 第一阶段只做 required artifact/evidence/gate，复杂语义交给 verifier Agent 或 human gate。 |
| collaboration 自动触发循环 | 使用 `max_depth`、`dedupe_key`、trace history 和 explicit trigger。 |

## 先做什么

建议下一步只实现 Phase 1。

原因：

- 风险低。
- 可以验证 RFC 字段是否能被现有 Agent Manager/API 承载。
- 不改变 Runtime 行为。
- 后续 Phase 3/4/5 都依赖 normalized metadata。

Phase 1 完成后，再根据实际 schema 和 UI 反馈决定是否调整 RFC 字段。
