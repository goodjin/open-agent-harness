# Agent Metadata RFC 完整实现方案

Status: Draft

Date: 2026-06-02

Source RFC: `10-agent-metadata-rfc.md`

## 目标

本方案说明 `10-agent-metadata-rfc.md` 中每类 metadata 如何落地到当前代码库、Runtime 行为、API/UI、测试和迁移路径。

实现可以分阶段，但规划必须覆盖 RFC 全部内容：

- identity and logo
- capability, input and output contracts
- instruction files and event-driven model messages
- collaboration edges
- runtime boundary
- artifact contract
- completion contract
- observability
- lifecycle and version snapshot

核心目标是证明：这些字段不是只写进 prompt 的装饰信息，而是能被 Runtime 解析、校验、投影、展示、执行、审计和评估的控制面。

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

当前 loader 位于 `packages/opencode/src/agent/loader.ts`，读取：

- `meta.json`
- `identity.md`
- `rules.md`
- legacy `SKILL.md`

当前管理 API 位于 `packages/opencode/src/agent/manage.ts`。

当前 Agent Manager 表单逻辑主要在：

- `packages/app/src/components/settings-agents-helpers.ts`
- `packages/app/src/components/settings-agents-helpers.test.ts`

当前 Runtime 相关落点：

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/runtime-tools.ts`
- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/tool/*`
- `packages/opencode/src/permission/*`

## 实现总览

Agent metadata 的完整实现分成八个系统能力。

| 能力 | 主要字段 | 代码落点 | Runtime 用途 |
|---|---|---|---|
| Metadata schema | `schema_version`、`agent_version`、`persona`、`logo`、`contracts` 等 | `agent/schema.ts` | 解析、默认值、校验、规范化 |
| Template loading | `instructions.files`、`logo.uri`、legacy files | `agent/loader.ts`、`agent/manage.ts` | 读取、诊断、返回 API |
| UI management | all metadata | app Agent Manager | 展示、编辑、保存、诊断 |
| Context instructions | `instructions.files`、`model_messages` | `agent/instructions.ts`、`session/prompt.ts` | 构造模型上下文，事件提示 |
| Contracts/artifacts | `contracts.input`、`contracts.output` | `agent/contracts.ts`、artifact index | 输入检查、输出接收、下游路由 |
| Completion | `completion` | `agent/completion.ts`、`session/runner.ts` | 判定 completed/partial/blocked/failed |
| Collaboration | `collaboration.edges` | `agent/collaboration.ts`、routing | 展开 Action/Assignment/Handoff |
| Boundary/version | `runtime_boundary`、`lifecycle` | permission/routing/snapshot | 权限候选、审批、版本快照 |

## 设计约束

- 不破坏现有 `meta.json`。
- 不让 metadata 直接授予 authority。
- Agent Session 之间仍不直接通信。
- 旧模板、legacy skills、builtin generated agents 必须继续加载。
- 新字段先进入 schema、diagnostics、API 和 UI，再逐步进入 Runtime 行为。
- 被运行使用过的 Agent 定义需要可追溯，后续编辑不能改写旧 run 的含义。
- 测试必须从 package 目录运行，不能从 repo root 跑。

## 命名兼容

RFC 使用 `persona`，当前代码使用 `role`。

实现规则：

- `role` 暂时保留为内部运行字段。
- `persona` 作为输入别名接受。
- `role` 和 `persona` 同时存在且不同，产生 warning，优先 `role`。
- parse 后输出的 `meta.role` 始终存在。
- Agent Manager 可以显示为 Persona，但保存时在迁移期继续写 `role`。

RFC 使用 `execution_mode`，当前代码使用 `workflow_mode`。

实现规则：

- 第一阶段保留 `workflow_mode`。
- `execution_mode` 作为输入别名接受。
- `workflow_mode` 和 `execution_mode` 同时存在且不同，产生 warning，优先 `workflow_mode`。
- parse 后输出 `workflow_mode`，避免立即改 Runtime。

当前 `inherit_permissions` 默认值是 `true`，RFC 倾向默认 `false`。

实现规则：

- 无 `schema_version` 的 legacy 模板保留默认 `true`。
- `schema_version: "agent.metadata.v1"` 的模板默认 `false`。
- 这样避免旧模板被静默降权，同时新协议采用独立权限边界。

## 数据模型

### Normalized Meta

新增内部概念：`AgentTemplate.NormalizedMeta`。

它是 Runtime 使用的稳定形态，负责吸收 alias、默认值和 legacy 字段。

建议字段：

```ts
type NormalizedMeta = {
  schema_version?: string
  agent_version?: string
  id: string
  name: string
  role: string
  description: string
  logo?: Logo
  model_preference?: ModelPreference
  entry: Entry
  capability: Capability
  hidden: boolean
  runner: Runner
  workflow_mode: WorkflowMode
  allowed_tools: string[]
  denied_tools: string[]
  inherit_permissions: boolean
  permission_mode: PermissionMode
  instructions?: Instructions
  contracts?: Contracts
  collaboration?: Collaboration
  runtime_boundary?: Boundary
  completion?: Completion
  observability?: Observability
  lifecycle?: Lifecycle
}
```

`MetaInput` 接受 legacy 和 RFC 字段；`Meta` 或 `NormalizedMeta` 面向 Runtime。

### Diagnostics

新增诊断类别：

- `schema`
- `alias`
- `path`
- `logo`
- `instruction`
- `contract`
- `collaboration`
- `boundary`
- `completion`
- `lifecycle`

Agent Manager 展示这些 diagnostics；Runtime 对 required 项按严重度决定 block、warning 或 ignore。

## 字段到实现矩阵

| RFC 字段 | Schema 校验 | Loader 处理 | UI 展示 | Runtime 使用 | 测试 |
|---|---|---|---|---|---|
| `schema_version` | enum/string | 标记 legacy/v1 默认值 | 展示 | 决定 parse 默认值 | schema |
| `agent_version` | semver-like string | 原样返回 | 展示 | snapshot/ref | schema, snapshot |
| `logo` | uri/alt/theme/hash | path/security diagnostics | image/fallback | catalog only | schema, UI |
| `entry` | existing | existing | existing | picker/routing | existing |
| `capability` | existing + tags | existing | existing | routing/context | existing |
| `instructions.files` | path/role/required | resolve/read/diagnose | count/detail | context bundle | instructions |
| `instructions.model_messages` | event/position/content | validate | list/detail | event injection | runner |
| `contracts.input` | source/type/schema/ref | validate refs | list/detail | input readiness | contracts |
| `contracts.output` | artifact/schema/evidence | validate refs | list/detail | artifact validation | contracts |
| `collaboration.edges` | kind/trigger/target/limits | validate | graph/count | Action/Assignment expansion | collaboration |
| `runtime_boundary` | resource/action/policy | normalize | summary | authority candidate/gate | permission |
| `completion` | criteria/gates/artifacts | validate | summary | status decision | completion |
| `observability` | trace/log/metrics config | normalize | summary | trace/log detail | observability |
| `lifecycle` | deprecated/replacement | normalize | badge | routing/snapshot | lifecycle |

## Phase 1: Schema、Loader、API 兼容

目标：让 RFC 全量字段都能被解析、校验、保存和通过 API 返回，但不改变 Runtime 行为。

### 代码改动

`packages/opencode/src/agent/schema.ts`：

- 增加 `schema_version`、`agent_version`。
- 增加 `Logo` schema：
  - `uri`
  - `alt`
  - `theme`
  - `hash`
- 增加 `Instructions` schema：
  - `files[]`
  - `model_messages[]`
- 增加 `Contracts` schema：
  - `input[]`
  - `output[]`
- 增加 `Collaboration` schema：
  - `edges[]`
  - `limits`
- 增加 `RuntimeBoundary` schema。
- 增加 `Completion` schema。
- 增加 `Observability` schema。
- 增加 `Lifecycle` schema。
- 支持 `persona` -> `role` alias。
- 支持 `execution_mode` -> `workflow_mode` alias。
- 支持 v1 默认 `inherit_permissions: false`。

`packages/opencode/src/agent/loader.ts`：

- 加载新字段，不执行。
- 对 `logo.uri`、`instructions.files[].path`、`schema_ref`、`target` 做基础 diagnostics。
- `identity.md` / `rules.md` 继续按 legacy 方式读取。
- legacy `SKILL.md` 转换出的 Agent 不自动生成 RFC 字段，只补 `schema_version` 可选诊断。

`packages/opencode/src/agent/manage.ts`：

- `Info.meta` 返回新字段。
- `ValidateOutput.diagnostics` 支持新诊断类别。
- `check/create/update` 使用新 schema 校验。

`packages/sdk/openapi.json` / SDK：

- 如果 API shape 变化，运行 `./packages/sdk/js/script/build.ts`。

### 失败处理

- 未知字段：v1 schema 默认拒绝，legacy 行为按现有 strict 策略。
- alias 冲突：warning，不阻塞。
- `required` instruction path 非法：warning in Phase 1，Phase 3 开始可 block。
- unsupported collaboration trigger：schema error。
- unsupported completion mode：schema error。

### 验收标准

- 旧 Agent 模板不修改也能加载。
- RFC 示例模板能通过 parse。
- `/agent` 返回 RFC 字段。
- diagnostics 能定位字段路径。
- OpenAPI/SDK 如有变化可生成。

### 测试

- `cd packages/opencode && bun test test/agent/schema.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/agent/loader.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/server/agent-manage.test.ts --timeout 30000`
- `cd packages/opencode && bun typecheck`

## Phase 2: Agent Manager 展示与编辑

目标：用户可以看到并编辑 RFC metadata，同时旧表单不丢字段。

### 代码改动

`packages/app/src/components/settings-agents-helpers.ts`：

- Form state 支持：
  - `schema_version`
  - `agent_version`
  - `logo`
  - `instructions`
  - `contracts`
  - `collaboration`
  - `runtime_boundary`
  - `completion`
  - `observability`
  - `lifecycle`
- 基础表单继续处理现有字段。
- 新字段第一版使用 Advanced JSON 编辑区，避免一次性做复杂 UI。
- `formToSaveInput` round-trip 不删除未知但已支持的 RFC 字段。

Agent Manager UI：

- 展示 logo fallback。
- 展示 schema version、agent version、deprecated badge。
- 展示 instruction file count。
- 展示 required input/output count。
- 展示 collaboration edge count。
- 展示 completion mode。
- 展示 runtime boundary summary。
- package/builtin Agent 保持只读。

### 失败处理

- logo 加载失败：fallback，不报错。
- Advanced JSON parse 失败：阻止保存，显示错误。
- unsupported metadata：由 server diagnostics 返回。

### 验收标准

- 现有 Agent 表单 round-trip 不丢字段。
- RFC metadata 保存后重新打开仍存在。
- package/builtin Agent 的新字段可读不可编辑。
- Disabled/deprecated 状态可区分显示。

### 测试

- `cd packages/app && bun test --preload ./happydom.ts ./src/components/settings-agents-helpers.test.ts`
- `cd packages/app && bun test --preload ./happydom.ts ./src/utils/agent.test.ts`
- `cd packages/app && bun typecheck`

## Phase 3: Instruction Files

目标：`instructions.files` 不只是 metadata，Runtime 能把它们解析成 Context Bundle 的受控材料。

### 代码改动

新增 `packages/opencode/src/agent/instructions.ts`：

```ts
namespace AgentInstructions {
  function resolve(input: {
    agent: AgentTemplate
    project: string
    workspace: string
    run?: string
  }): ResolvedInstruction[]
}
```

职责：

- 解析 path variables。
- 校验路径不能越过允许 root。
- 读取 required/optional 文件。
- 返回 content、role、path、source、hash、diagnostics。

`packages/opencode/src/session/prompt.ts`：

- 在 prompt/context 构造时合并 resolved instruction files。
- 顺序：
  1. Runtime/system base prompt
  2. legacy `identity.md`
  3. legacy `rules.md`
  4. `instructions.files` 按配置顺序
  5. Assignment-specific constraints
- 每个 instruction source 写入 trace/context metadata。

### 路径变量

支持：

- `${agent.dir}`
- `${project.root}`
- `${workspace.root}`
- `${global.rules}`
- `${user.home}`
- `${run.dir}`

解析规则：

- 未知变量：diagnostic error。
- required 文件不存在：Assignment `blocked`。
- optional 文件不存在：diagnostic warning。
- 文件超过大小上限：截断或 block，由 `max_bytes` 决定。
- 文件含敏感内容：按 redaction/visibility 处理。

### 验收标准

- required instruction file 缺失会阻止执行。
- optional instruction file 缺失不阻止执行。
- Context Bundle summary 能列出注入来源。
- instruction 不伪装成用户消息。

### 测试

- 新增 `packages/opencode/test/agent/instructions.test.ts`。
- `cd packages/opencode && bun test test/session/prompt-runner.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/session/llm.test.ts --timeout 30000`

## Phase 4: Event-Driven Model Messages

目标：Runtime 在事件发生时向模型追加受控提示，例如 validation failed、budget near limit、completion rejected。

### 代码改动

新增 `packages/opencode/src/agent/messages.ts`：

- 根据 `instructions.model_messages` 选择匹配事件。
- 支持 `position`：
  - `prefix`
  - `suffix`
  - `observation`
- 输出 Runtime-authored message part，标注 source。

`packages/opencode/src/session/runner.ts`：

- 在这些事件点调用 message resolver：
  - `before_model_call`
  - `after_tool_result`
  - `output_validation_failed`
  - `budget_near_limit`
  - `dependency_completed`
  - `dependency_failed`
  - `risk_detected`
  - `completion_rejected`

Trace/Event：

- 追加 `runtime.model_message.injected` Event。
- 记录 `agent_id`、`message_id`、`trigger`、`position`、`visibility`。

### 失败处理

- message content 为空：schema error。
- trigger unsupported：schema error。
- injection 造成 context budget 超限：按 priority 截断低优先级 message。

### 验收标准

- output validation failed 后，模型能收到修正提示。
- completion rejected 后，模型能收到具体缺失项。
- event message 在 trace 中可见。
- event message 不进入用户 transcript 伪装成用户输入。

### 测试

- 新增 `packages/opencode/test/agent/messages.test.ts`。
- `cd packages/opencode && bun test test/session/runner.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/protocol/schema.test.ts --timeout 30000`

## Phase 5: Input Contracts

目标：Runtime 在创建 Assignment 前判断 Agent 是否有足够输入。

### 代码改动

新增 `packages/opencode/src/agent/contracts.ts`：

- `validateInput(agent, assignment, projection, artifacts, memory)`
- 检查 required input 是否存在。
- 检查 source 类型是否允许。
- 检查 content type / artifact type。
- 检查 visibility 是否允许进入 model。
- 对 `schema_ref` 第一版只识别 registry key，不执行复杂验证。

Routing/Assignment 创建路径：

- target Agent 选定后，执行 input contract check。
- 缺 required input 时：
  - 有 matching `collaboration.prerequisite`：触发 prerequisite edge。
  - 否则进入 `blocked` 或 `waiting_user`。

### 验收标准

- 调研 Agent 缺 product brief 时不会直接运行。
- 如果配置了 web/product prerequisite，可先展开 prerequisite Assignment。
- 输入存在但 visibility 不允许进入模型时，Runtime block 或降级为 summary/ref。

### 测试

- 新增 `packages/opencode/test/agent/contracts.test.ts`。
- 覆盖 missing input、wrong artifact type、visibility denied、prerequisite available。

## Phase 6: Output Contracts 与 Artifact Acceptance

目标：模型输出不是自由文本直接算完成。Runtime 要根据 output contract 接收 Artifact。

### 代码改动

Artifact Index 落点可先复用现有 Artifact/Trace 结构，如不足再新增轻量 `agent/artifact.ts`。

`packages/opencode/src/agent/contracts.ts` 增加：

- `validateOutput(agent, assignment, outputs, artifacts)`
- 检查 required output artifact 是否存在。
- 检查 artifact type。
- 检查 required evidence。
- 检查 schema_ref。

`packages/opencode/src/session/runner.ts`：

- 当 Agent 产出 result 或 `done` 时，调用 output validator。
- 通过则 artifact status 为 `available`。
- 不通过则 artifact status 为 `invalid` 或 Assignment `partial`。

### 验收标准

- `test_report` 必须包含 commands 和 exit codes。
- `research_report` 必须包含 source refs。
- invalid output 不进入 completed。
- UI/Trace 能看到 output validation result。

### 测试

- `cd packages/opencode && bun test test/agent/contracts.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/protocol/executor.test.ts --timeout 30000`

## Phase 7: Completion Contract

目标：任务完成由 Runtime 判定，模型的 `done` 只是候选信号。

### 代码改动

新增 `packages/opencode/src/agent/completion.ts`：

```ts
namespace AgentCompletion {
  function evaluate(input: {
    agent: AgentTemplate
    assignment: AssignmentProjection
    artifacts: ArtifactRecord[]
    gates: GateRecord[]
    unresolved: string[]
    dependencies: DependencyState[]
  }): CompletionDecision
}
```

`CompletionDecision`：

- `status`: `completed` | `partial` | `blocked` | `failed` | `waiting_user`
- `reasons`
- `missing_artifacts`
- `missing_evidence`
- `failed_gates`
- `unresolved`
- `next`

`packages/opencode/src/session/runner.ts`：

- 模型输出 `done` 后调用 completion evaluator。
- decision 为 `completed` 才进入 completed。
- decision 为 `partial` 时保留可用 artifact，并暴露缺失项。
- decision 为 `blocked/waiting_user` 时进入对应状态。
- decision rejected 时触发 `completion_rejected` model message 或 verifier/recovery edge。

### 完成判定顺序

1. dependency state
2. required collaboration edge state
3. required artifacts
4. required evidence
5. output schema/ref validation
6. gates
7. unresolved issues
8. budget/failure policy

### 验收标准

- 模型只说完成但没有 required artifact，不能 completed。
- 有 patch 但没有 test report，可 partial。
- 需要用户决策时 waiting_user。
- verifier 失败时 blocked/failed，按 failure policy 决定。

### 测试

- 新增 `packages/opencode/test/agent/completion.test.ts`。
- `cd packages/opencode && bun test test/session/runner.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/session/llm.test.ts --timeout 30000`

## Phase 8: Collaboration Edges

目标：把 `collaboration.edges` 展开为受 Runtime 控制的 Action、Assignment 或 Handoff，覆盖前置、验证、仲裁、恢复、fallback、拆分、聚合、升级等协作关系。

### 代码改动

新增 `packages/opencode/src/agent/collaboration.ts`：

- `matchEdges(agent, trigger, projection, trace)`
- `expandEdge(edge, source)`
- `dedupe(edge, trace)`
- `checkLimits(edge, trace)`

支持 edge kinds：

- `prerequisite`
- `verifier`
- `reviewer`
- `arbiter`
- `fallback`
- `recovery`
- `monitor`
- `splitter`
- `aggregator`
- `escalation`
- `peer`
- `blocker`

第一批执行实现：

- `prerequisite`
- `verifier`
- `recovery`
- `arbiter`
- `fallback`

第二批实现：

- `splitter`
- `aggregator`
- `monitor`
- `peer`
- `escalation`
- `blocker`

Routing 规则：

- target 指定具体 Agent：检查存在、enabled、entry.delegable、permission、availability。
- target 指定 capability：通过 registry 做 candidate selection。
- 每个 expanded Assignment 独立推导 authority。
- source Agent 的权限不传给 target Agent。
- 所有展开写入 trace。

### 失败处理

- required edge 失败：parent 进入 blocked/failed/partial。
- optional edge 失败：记录 warning，不阻塞 parent。
- target unavailable：尝试 fallback edge。
- 循环：根据 `dedupe_key`、`max_depth`、trace history 阻止。
- fan-out 超限：按 `max_parallel` 排队或 block。

### 验收标准

- 调研 Agent 可在开始前触发 web research。
- developer 产出 patch 后自动触发 test Agent。
- test fail 后触发 debugger。
- reviewer 结果冲突后触发 arbiter。
- target unavailable 时 fallback 被触发。
- 循环不会无限展开。

### 测试

- 新增 `packages/opencode/test/agent/collaboration.test.ts`。
- `cd packages/opencode && bun test test/server/agent-manage.test.ts --timeout 30000`
- `cd packages/opencode && bun test test/session/runner.test.ts --timeout 30000`

## Phase 9: Runtime Boundary

目标：把 `runtime_boundary` 转换为 Assignment authority 的候选边界，覆盖非编程 Agent。

### 代码改动

`packages/opencode/src/agent/schema.ts`：

- `resource_classes`
- `actions.read`
- `actions.write`
- `actions.execute`
- `actions.communicate`
- `actions.publish`
- `actions.spend`
- `actions.delete`
- `actions.approve`
- `network.allow/deny`
- `data.max_classification`
- `data.redact`
- `approval.required_for`
- `rate_limits`

新增 `packages/opencode/src/agent/boundary.ts`：

- 将 metadata boundary 转成 authority candidate。
- 与 run policy、user approval、project policy merge。
- 输出 allowed/denied/blocker reason。

permission/routing 路径：

- 在选择 executor 前评估 boundary。
- 高风险 action 进入 approval gate。
- 不支持的资源类别进入 blocked。

### 资源类别

第一批：

- `filesystem`
- `network`
- `browser`
- `secret`
- `personal_data`
- `service`
- `human_contact`

第二批：

- `email`
- `calendar`
- `database`
- `cloud`
- `payment`
- `crm`
- `messaging`

### 验收标准

- Research Agent 可以声明 web/network 范围。
- Browser Agent 可以声明 browser 范围。
- Customer support Agent 可以声明 email/human_contact，但发送需要 approval。
- Payment/expense Agent 的 spend action 必须 approval。
- metadata 仍不直接授权，最终 authority 来自 Runtime。

### 测试

- 新增 `packages/opencode/test/agent/boundary.test.ts`。
- 覆盖 read/write/communicate/publish/spend/delete/approve。
- 根据具体 executor 增加 integration tests。

## Phase 10: Observability

目标：metadata 影响 Trace、logs、metrics、evaluation 的可见程度。

### 代码改动

`observability` schema：

- `trace_level`: `minimal` | `standard` | `detailed`
- `log_level`: `minimal` | `standard` | `debug`
- `metrics`: string[]
- `capture_context_summary`: boolean
- `capture_artifact_summary`: boolean
- `redaction_profile`: string

Trace 路径：

- Agent Session 创建时记录 observability config。
- Event/Trace export 根据 trace_level 决定摘要粒度。
- logs 根据 log_level 控制是否保留 executor metadata。

### 验收标准

- high-risk Agent 能开启 detailed trace。
- privacy-sensitive Agent 能限制 logs 进入 full raw output。
- trace export 仍遵守 visibility/redaction。

### 测试

- `cd packages/opencode && bun test test/server/audit.test.ts --timeout 30000`
- 增加 observability unit tests。

## Phase 11: Lifecycle 与 Version Snapshot

目标：Agent 更新不改写旧 run 的含义。

### 代码改动

`lifecycle` schema：

- `deprecated`
- `replacement`
- `migration`
- `compatibility`
- `retention`

Assignment 创建时记录：

- `agent_id`
- `agent_version`
- `schema_version`
- `agent_snapshot_hash`
- `agent_snapshot_ref`

Snapshot 内容：

- normalized meta
- identity/rules content hash
- resolved instruction refs/hash
- source dir/package revision

Agent Manager：

- deprecated badge。
- replacement link。
- 禁止普通 routing 选择 deprecated Agent，除非显式指定或 replay。

### 验收标准

- running session 不受 Agent 编辑影响。
- old run trace 能看到当时 Agent snapshot。
- deprecated Agent 不进入普通 routing。
- replacement 可在 UI 和 diagnostics 中显示。
- replay 使用 snapshot，而不是 active Agent。

### 测试

- 新增 `packages/opencode/test/agent/snapshot.test.ts`。
- 覆盖 active update、running session、historical replay、deprecated routing。

## Phase 12: Migration

目标：从现有 Agent metadata 平滑迁移到 RFC v1。

### 迁移策略

- 不强制批量改现有 builtin Agent。
- Loader 接受 legacy meta。
- Agent Manager 保存新模板时默认写 `schema_version: "agent.metadata.v1"`。
- 对 legacy 模板显示 migration suggestion。
- `role`/`workflow_mode` 保留到 v1 完成后再讨论是否改名。

### 生成/构建

如果 builtin Agent metadata 生成脚本输出 schema：

- 更新 `packages/opencode/script/build.ts` 或相关生成逻辑。
- 重新生成 `packages/opencode/src/agent/builtin.generated.ts`。

### 验收标准

- existing builtin generated agents 不崩。
- user/project agents 不需要迁移也能运行。
- 新建 agent 使用 v1 schema。
- Update 后不丢 legacy `identity.md`/`rules.md`。

## 端到端场景

### 场景 A: 调研 Agent

配置：

- input contract: product brief。
- prerequisite edge: web research Agent。
- output contract: research report with source refs。
- runtime boundary: network/browser read allowed，publish denied。
- completion: required research_report + source_refs。

流程：

1. 用户提交调研任务。
2. Runtime 发现缺 source brief。
3. collaboration prerequisite 展开 web research Assignment。
4. web research 产出 source_brief Artifact。
5. main researcher 获取 source_brief summary。
6. researcher 产出 market_research_report。
7. completion 检查 source refs。
8. Run completed 或 partial。

### 场景 B: 开发 Agent

配置：

- output contract: patch。
- verifier edge: code_test after patch。
- reviewer edge: technical_reviewer after test_report。
- completion: patch + test_report required。
- runtime boundary: filesystem write allowed within workspace。

流程：

1. developer 产出 patch。
2. Runtime 接收 patch Artifact。
3. verifier edge 触发 code_test。
4. code_test 产出 test_report。
5. reviewer edge 触发 technical_reviewer。
6. completion 检查 patch/test_report/review_report。
7. 缺 review 时 partial，不直接 completed。

### 场景 C: 业务客服 Agent

配置：

- input contract: customer ticket。
- runtime boundary: email read allowed, email send requires approval。
- output contract: response draft。
- completion: response_draft required, human approval required before send。

流程：

1. Agent 读取 ticket。
2. 生成 response_draft。
3. Runtime 进入 waiting_permission。
4. 用户批准后 service/email executor 发送。
5. 发送回执成为 evidence。
6. completion completed。

## 推荐 PR 拆分

1. `docs: add agent metadata RFC`
2. `docs: add complete agent metadata implementation plan`
3. `feat(agent): parse metadata control-plane fields`
4. `feat(agent): expose metadata in agent manager`
5. `feat(agent): resolve instruction files`
6. `feat(agent): inject event model messages`
7. `feat(agent): validate input and output contracts`
8. `feat(agent): evaluate completion contracts`
9. `feat(agent): expand collaboration edges`
10. `feat(agent): derive runtime boundary authority`
11. `feat(agent): snapshot agent metadata versions`
12. `feat(agent): add observability controls`

## 测试总矩阵

| 测试类型 | 覆盖 |
|---|---|
| schema unit | all new fields, alias, defaults, invalid values |
| loader unit | meta load, diagnostics, legacy compatibility |
| manager API | validate/create/update/list/get |
| app unit | form round-trip, logo fallback, advanced JSON |
| instruction unit | path variables, required/optional, redaction |
| event message unit | trigger matching, position, trace refs |
| contract unit | missing input, invalid output, artifact evidence |
| completion unit | completed/partial/blocked/failed/waiting_user |
| collaboration unit | trigger, dedupe, fallback, limits |
| boundary unit | resource class, approval, deny, blocker reason |
| snapshot unit | version pinning, deprecated routing, replay |
| integration | research chain, dev-test-review chain, business approval chain |

## 风险与处理

| 风险 | 处理 |
|---|---|
| 字段太多，评审成本高 | schema 全量规划，行为分阶段启用。 |
| 新字段进入 Runtime 后影响旧 Agent | legacy 默认保留，v1 行为只对 v1 metadata 启用。 |
| prompt 注入不可审计 | 所有 event model messages 写入 trace。 |
| output contract 变成 prompt 建议 | Runtime 接收 Artifact 时执行校验。 |
| completion 误判 | deterministic checks 优先，语义判断交给 verifier/human gate。 |
| collaboration 形成循环 | `max_depth`、`max_parallel`、`dedupe_key`、trace history。 |
| runtime_boundary 与现有 permission 冲突 | boundary 只生成 authority candidate，最终由 Runtime merge/gate。 |
| snapshot 成本变大 | 存 normalized meta/hash/ref，raw content 只在需要时保存。 |

## 实施顺序建议

完整实现需要按依赖推进：

1. Schema/loader/API。
2. Agent Manager round-trip。
3. Instruction files。
4. Event model messages。
5. Contracts and Artifact acceptance。
6. Completion evaluator。
7. Collaboration edges。
8. Runtime boundary authority。
9. Version snapshot and lifecycle。
10. Observability and evaluation polish。

这样每一步都能独立合并，并且每一步都证明 RFC 中一部分 metadata 的可行性。Phase 1 只是起点，不是完整实现方案的终点。
