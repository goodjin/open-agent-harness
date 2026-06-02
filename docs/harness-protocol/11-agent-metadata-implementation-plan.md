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

## RFC 对齐核查矩阵

| RFC 章节 / 逻辑 | 实现方案覆盖 | 状态 |
|---|---|---|
| Summary 中的 metadata control plane | 实现总览、字段到实现矩阵、Phase 1-12 | covered |
| Core Principle: metadata 不直接授予 authority | 设计约束、Phase 9 Runtime Boundary、风险处理 | covered |
| Top-level shape | Normalized Meta、Phase 1 schema | covered |
| Identity and logo | 字段到实现矩阵、Phase 1、UI Overview/List | covered |
| Capability, input and output contracts | Phase 5 Input Contracts、Phase 6 Output Contracts、Contracts UI | covered |
| Runtime uses contracts in input check/context/output/routing | Phase 5、Phase 6、Phase 7、端到端场景 | covered |
| Instruction files | Phase 3、Instructions UI | covered |
| Event-driven model messages | Phase 4、Instructions UI、Trace/Event 规则 | covered |
| Collaboration beyond before/after | Phase 8、Collaboration UI、端到端场景 | covered |
| Runtime boundary for non-programming agents | Phase 9、Runtime Boundary UI、业务客服场景 | covered |
| Artifact Contract | Phase 6、Artifact Record Implementation、测试矩阵 | covered |
| Completion Contract | Phase 7、Completion UI、端到端场景 | covered |
| Versioning and old-run preservation | Phase 11 Lifecycle 与 Version Snapshot | covered |
| Scope boundaries: Workflow Profile / Action Graph 由对应协议定义，Agent Session 协作由 Runtime 协调 | 设计约束、Phase 8 expansion 规则、风险处理 | covered |
| Submission / PR plan | 推荐 PR 拆分 | covered |
| Tests required for schema, loader, Agent Manager, routing and completion | 测试总矩阵、各 Phase 测试 | covered |

## 关键定义实现细节

### Logo

RFC 定义 `logo.uri` 支持 local path、package path、data URI 或 trusted remote URI。实现上分三类处理：

- Local/package path：允许 path variables，解析后必须落在 `${agent.dir}`、package agent dir 或受信任 assets root 内。
- Data URI：只允许 image MIME，设置 size cap，超限产生 diagnostic。
- Remote URI：默认不自动加载；只有命中 allowlist 且 hash 存在时才允许 UI 使用。

`hash` 用于 package/remote asset integrity。hash 不匹配时，UI 使用 fallback initials，Runtime 记录 logo diagnostic，但不阻止 Agent 运行。

### Input Contract

Input contract 的实现字段应覆盖 RFC 中的“格式”和“语义”两层：

- source：user、artifact、memory、url、file、event、decision、api_payload。
- content_type：text、json、markdown、image、pdf、csv、patch、browser_state、email_thread 等。
- artifact_type：当 source 包含 artifact 时使用。
- schema_ref：JSON Schema 或 domain validator key。
- semantic：freshness、citations、language、scope、confidence、market、resource range。
- visibility：model/user/logs/trace/future_runs/runtime_only 约束。

Runtime 使用 input contract 判断是否可以创建 Assignment；缺输入时进入 `blocked` / `waiting_user`，或触发 collaboration prerequisite。

### Output Contract

Output contract 的实现字段应覆盖：

- name
- required
- artifact_type
- content_type
- schema_ref
- required evidence
- downstream consumers
- visibility
- completion_role

Runtime 不把 output contract 当 prompt 建议。模型可以按 contract 生成结果，但 Runtime 要在 Artifact acceptance 阶段校验是否满足 contract。

### Collaboration Edge Semantics

| Edge kind | Runtime 展开行为 |
|---|---|
| prerequisite | 当前 Assignment 启动前创建上游 Assignment，产物进入当前 Context Bundle。 |
| verifier | 当前 Artifact 产生后创建验证 Assignment，验证结果进入 completion。 |
| reviewer | 当前结果产生后创建审查 Assignment，审查结果进入 gate 或 completion。 |
| arbiter | 多个结果冲突时创建仲裁 Assignment。 |
| fallback | 首选 target 不可用或失败时选择替代 target。 |
| recovery | 当前失败后创建诊断/恢复 Assignment。 |
| monitor | 对长任务或外部状态创建周期/条件观察 Action。 |
| splitter | 把一个目标拆成多个 child Assignment。 |
| aggregator | 合并多个 child Artifact，生成聚合 Artifact。 |
| escalation | 创建 human 或高权限 Agent Decision/Assignment。 |
| peer | 并行创建同类 Agent 以获得多样化结果。 |
| blocker | 匹配风险条件时阻止自动展开或进入 approval gate。 |

所有 edge 展开都必须经过 routing、permission、budget、gate、event、projection 和 trace。Agent Session 不直接互相通信。

### Artifact Record Implementation

Artifact contract 定义期望产物，Artifact record 记录实际产物。

实际 Artifact record 至少包含：

- `id`
- `name`
- `artifact_type`
- `producer`
- `status`
- `uri`
- `schema_ref`
- `validation.status`
- `validation.validator`
- `summary`
- `evidence`
- `visibility`

状态建议：

- `expected`
- `available`
- `invalid`
- `missing`
- `redacted`
- `superseded`

Output contract validation 只把 `available` 且 validation passed 的 Artifact 作为 completion 输入。`invalid` 或 `missing` 会进入 completion reason。

### Completion Sources

Completion evaluator 支持多种证据来源：

- deterministic validators
- tool results
- Artifact validation
- verifier Agent result
- reviewer Agent result
- human decision
- service callback
- external gate

模型输出 `done` 只是候选信号。Runtime 根据 completion contract 选择 `completed`、`partial`、`blocked`、`failed` 或 `waiting_user`。

### Versioning Fields

Lifecycle/version 实现应覆盖 RFC 的所有版本字段：

- `schema_version`
- `agent_version`
- `revision`
- `compatibility`
- `deprecated`
- `replacement`
- `migration`
- `retention`

`revision` 可以是 package revision、content hash 或 config revision。Assignment snapshot 同时记录 `agent_version` 和 `revision`，避免同版本号下内容变更导致 replay 不稳定。

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

## UI 改造方案

Phase 2 不能只增加几个字段。Agent metadata 变成控制面以后，Agent Manager 需要从“配置表单”升级成“Agent 控制面编辑器”。

### 信息架构

Agent Manager 分成三层：

- Agent list：用于浏览、筛选、选择和启用/禁用 Agent。
- Agent detail：用于查看一个 Agent 的 metadata、diagnostics、runtime summary 和引用状态。
- Agent editor：用于编辑 user/project Agent；package/builtin Agent 只读。

推荐 detail/editor tabs：

- Overview：身份、logo、版本、source、entry、capability、deprecated/replacement。
- Instructions：legacy identity/rules、`instructions.files`、event model messages。
- Contracts：input contracts、output contracts、artifact expectations。
- Collaboration：collaboration edges、trigger、target、required、limits。
- Runtime Boundary：resource classes、actions、network/data/approval/rate limits。
- Completion：criteria、required artifacts、evidence、gates、partial policy。
- Observability：trace level、log level、metrics、redaction profile。
- Advanced JSON：完整 metadata JSON，支持 schema diagnostics。

### Agent List

列表需要从普通名称列表升级成可扫描的 Agent catalog。

每个 row/card 显示：

- logo 或 fallback initials。
- name、id、source、kind。
- enabled/disabled、deprecated、hidden badges。
- entry summary：primary、delegable、mentionable、default。
- capability purpose、tags、cost、writes。
- schema version、agent version。
- diagnostics count。

筛选项：

- source：builtin、package、user、project。
- kind：agent、skill。
- enabled state。
- entry flags。
- capability purpose/tags。
- cost/writes。
- deprecated/hidden。
- diagnostics only。

交互：

- 点击进入 detail。
- 启用/禁用仍通过现有 Command/API。
- package/builtin Agent 展示 lock/read-only state。

### Overview Tab

Overview 是默认首屏，用于回答“这个 Agent 是谁、能不能被用、怎么被 Runtime 看见”。

字段区域：

- Identity：logo、name、id、description、persona/role。
- Version：schema_version、agent_version、snapshot status、deprecated/replacement。
- Entry：primary、delegable、mentionable、default、hidden。
- Capability：purpose、tags、cost、writes。
- Runtime：runner、workflow_mode/execution_mode、model_preference。
- Permission summary：permission_mode、inherit_permissions、allowed/denied tools。

UI 规则：

- logo 用 `img` 加 fallback，不让坏路径撑坏布局。
- id 不允许在 update 中修改。
- deprecated Agent 显示 replacement 链接。
- hidden 和 disabled 分开显示：hidden 是入口可见性，disabled 是 Runtime 可用性。

### Instructions Tab

该 tab 负责 rules/prompt 注入相关配置。

区域：

- Legacy material：`identity.md`、`rules.md`，保持现有编辑能力。
- Instruction files：表格编辑 `path`、`role`、`required`、可选 `max_bytes`。
- Path variable helper：展示可用变量 `${agent.dir}`、`${project.root}`、`${workspace.root}`、`${global.rules}`、`${user.home}`、`${run.dir}`。
- Event model messages：表格编辑 `on`、`position`、`content`、priority。

交互：

- required file 缺失显示 warning/error。
- 未知变量在保存前标红。
- event trigger 使用 select，不让用户手写未知 trigger。
- content 使用多行编辑器。

### Contracts Tab

Contracts tab 负责输入、输出和 artifact expectation。

Input contracts 表格：

- name
- required
- source
- content_type
- artifact_type
- schema_ref
- constraints
- visibility requirements

Output contracts 表格：

- name
- required
- artifact_type
- content_type
- schema_ref
- required evidence
- completion_role
- downstream consumers
- visibility

交互：

- 支持添加/删除 contract。
- schema_ref 暂时自由输入，但显示 registry recognition status。
- required output 自动出现在 Completion tab 的建议项里。
- artifact_type 用已有类型 suggestions，避免随意拼写。

### Collaboration Tab

Collaboration tab 展示 event-conditioned coordination，不只展示前置/后置。

视图：

- Edge table：id、kind、trigger、target、required、order、when、limits。
- Graph preview：source Agent -> edge -> target capability/Agent。
- Limit summary：max_depth、max_parallel、dedupe_key。

Edge kind select：

- prerequisite
- verifier
- reviewer
- arbiter
- fallback
- recovery
- monitor
- splitter
- aggregator
- escalation
- peer
- blocker

Trigger select：

- before_assignment_start
- after_artifact_created
- on_failed
- on_conflict
- on_target_unavailable
- budget_near_limit
- risk_detected
- completion_rejected

交互：

- target 可以选择具体 Agent，也可以选择 capability。
- required edge 显示会影响 completion 的提示。
- blocker/fallback/recovery 使用不同 badges。
- graph preview 第一版可以是只读列表，不必立即做复杂 canvas。

### Runtime Boundary Tab

Runtime Boundary tab 面向非编程 Agent 的运行边界。

区域：

- Resource classes：filesystem、network、browser、email、calendar、database、cloud、payment、crm、messaging、human_contact、secret、personal_data。
- Actions matrix：read、write、execute、communicate、publish、spend、delete、approve。
- Network policy：allow/deny domains or categories。
- Data policy：max_classification、redact fields。
- Approval policy：required_for。
- Rate limits：requests_per_minute、max_cost_usd。

交互：

- actions matrix 用 checkbox/table，不要求用户写 JSON。
- 高风险动作 publish/spend/delete/communicate 默认显示 approval warning。
- 第一版可以用 Advanced JSON 编辑详细规则，但 Overview 必须展示 summary。

### Completion Tab

Completion tab 用来解释“Runtime 怎么判断任务完成”。

区域：

- mode：runtime_verified、model_declared、human_approved、external_callback。
- criteria list。
- required artifacts。
- required evidence。
- gates。
- allow_partial。

Completion preview：

- 根据 output contracts 自动生成 missing checklist。
- 显示 completed/partial/blocked/failed/waiting_user 的判定规则摘要。
- required collaboration edge 也显示为 completion dependency。

交互：

- 从 Output contracts 一键添加 required artifact。
- 从 Collaboration required edges 一键添加 dependency。
- gate 类型用 select：schema、evidence、verification、review、approval、privacy、budget。

### Observability Tab

区域：

- trace_level：minimal、standard、detailed。
- log_level：minimal、standard、debug。
- metrics list。
- capture_context_summary。
- capture_artifact_summary。
- redaction_profile。

交互：

- detailed trace 显示隐私成本提示。
- debug log 对 secret/personal_data boundary 显示 redaction warning。

### Advanced JSON

Advanced JSON 是第一版落地的关键，避免一次性做完所有复杂控件。

要求：

- 展示 normalized metadata。
- 支持编辑 user/project Agent 的 raw metadata。
- 保存前调用 validate API。
- diagnostics 按 path 高亮。
- JSON 格式化和恢复上一次有效版本。
- 不允许 package/builtin Agent 编辑。

### Diagnostics Panel

所有 tab 共用 diagnostics panel。

显示：

- severity：error、warning、info。
- category：schema、path、instruction、contract、collaboration、boundary、completion、lifecycle。
- field path。
- message。
- suggested fix。

规则：

- error 阻止保存。
- warning 允许保存但保存后仍显示。
- info 作为 migration suggestion。

### 文件落点

现有可复用文件：

- `packages/app/src/components/settings-agents-helpers.ts`
- `packages/app/src/components/settings-agents-helpers.test.ts`

建议新增或拆分：

- `packages/app/src/components/settings-agents-editor.tsx`
- `packages/app/src/components/settings-agent-overview.tsx`
- `packages/app/src/components/settings-agent-instructions.tsx`
- `packages/app/src/components/settings-agent-contracts.tsx`
- `packages/app/src/components/settings-agent-collaboration.tsx`
- `packages/app/src/components/settings-agent-boundary.tsx`
- `packages/app/src/components/settings-agent-completion.tsx`
- `packages/app/src/components/settings-agent-diagnostics.tsx`
- `packages/app/src/components/settings-agent-json.tsx`

如果当前 settings 页面不适合拆这么多文件，可以先保留一个文件实现，但 helper/test 要按 tab 逻辑拆函数。

### UI 分阶段

第一版：

- Agent list 增加 logo、version、diagnostics、metadata summary。
- Detail 使用 Overview + Advanced JSON + Diagnostics。
- 新字段通过 Advanced JSON 编辑。
- 保证 round-trip 不丢字段。

第二版：

- 增加 Instructions、Contracts、Completion 三个结构化 tab。
- 支持 path variable helper 和 completion preview。

第三版：

- 增加 Collaboration graph、Runtime Boundary matrix、Observability tab。
- 支持 edge preview 和 boundary risk warnings。

### UI 验收标准

- 新 metadata 字段在 UI 中可见。
- user/project Agent 可以编辑并保存 RFC metadata。
- package/builtin Agent 只读。
- Advanced JSON 保存前有 schema validation。
- diagnostics 能定位到具体 tab 和字段。
- logo fallback 正常。
- output contracts、completion、collaboration 的摘要能在 Overview 中看见。
- 表单 round-trip 不丢 unknown-but-supported metadata。

### UI 测试

- `settings-agents-helpers.test.ts` 覆盖 metadata form round-trip。
- Advanced JSON parse failure。
- Diagnostics path mapping。
- logo fallback。
- read-only package/builtin behavior。
- completion summary generation。
- collaboration edge summary generation。

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
