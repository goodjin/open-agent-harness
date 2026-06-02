# 系统架构与技术方案

## 1. 架构目标

新项目从零实现 Harness Platform，但可以参考当前项目中成熟的模型调用、工具抽象、Agent registry、Hono API 和桌面/Web 双形态经验。

架构目标：

- 协议优先：Runtime Kernel 围绕 Command、Action、Event、Projection 和 Trace 构建。
- TypeScript 优先：协议 schema、Runtime、API、UI 和 SDK 使用同一种语言维护。
- 状态可恢复：Event Log、Materialized State、Projection、Snapshot 和 Artifact Index 支持 replay 和 rehydration。
- 执行可隔离：每个 executor 通过 Manifest 获得明确 Workspace、Sandbox、工具、网络和 secret 边界。
- UI 可治理：前端只读取 Projection 和 Trace，通过 Command 推进状态。
- Adapter 可扩展：Workflow、Evaluation、Release Gate 和 Monitor 作为 Adapter 运行在同一 Runtime 模型上。

## 2. 总体架构

```txt
Client Surfaces
  Web Console / Desktop App / CLI / SDK
        |
        v
Runtime API
  Command API / Query API / Trace API / Agent API / Adapter API
        |
        v
Runtime Kernel
  Command handler
  Action normalizer
  Policy and gate evaluator
  Action graph scheduler
  Executor router
  Event writer
  Projection builder
  Trace builder
  Context builder
        |
        +--------------------+
        |                    |
        v                    v
Model Gateway          Executor Layer
  provider adapters      tool
  toolCall carrier       agent session
  observation policy     runtime service
  fallback/cache         human
                         pipeline
                         external service
        |
        v
State Layer
  Event store
  Materialized state
  Projection store
  Trace store
  Artifact store
  Memory store
  Snapshot store
```

## 3. 技术选型

| 层级 | 推荐方案 | 原因 |
|---|---|---|
| 语言 | TypeScript | 与模型协议、schema、API、SDK、前端共享类型；适合快速迭代协议对象。 |
| 运行时 | Bun for local/dev，Node.js LTS for server compatibility | Bun 适合本地工具和快速开发；Node 生态更适合长期服务部署。部署时可按目标环境二选一。 |
| API 框架 | Hono | 轻量、类型友好、可运行在 Node/Bun/Workers，当前项目已有参考。 |
| Schema | Zod | Runtime validation、OpenAPI、SDK 类型生成和测试样例共享。 |
| 数据库 | SQLite local-first，PostgreSQL team/server | SQLite 适合本地桌面和单用户；PostgreSQL 适合团队、多租户和高并发。 |
| ORM / Query | Drizzle | TypeScript 类型友好、SQL 透明、迁移简单，适合 Event/Projection 表结构。 |
| 前端 | React + TanStack Router/Query + Radix UI | 新项目生态成熟、组件和状态管理选择多，适合复杂控制台。 |
| 桌面 | Tauri v2 | 提供本地文件、进程、权限和系统集成，同时复用 Web UI。 |
| 模型网关 | AI SDK + 直接 provider adapter | AI SDK 覆盖多 provider；关键协议 carrier 和 observation policy 由 Runtime 自己控制。 |
| 后台调度 | 自研 Action Graph scheduler | Harness 的调度语义来自协议，先由 Runtime 自己实现；Temporal/Cloudflare Workflows 可作为 Adapter。 |
| 事件与 Trace | 内部 Event/Trace 模型 + OpenTelemetry export | 内部模型服务协议治理；OTel 服务基础设施观测。 |
| Artifact 存储 | Local filesystem / object storage adapter | 本地先落盘；团队版接 S3/R2/MinIO。 |
| 测试 | Bun test / Vitest + Playwright | Runtime 和 schema 用快速单元测试；UI 用浏览器验证关键流程。 |

## 4. TypeScript 与 Go 的边界

默认不把核心 Runtime 改写为 Go。

原因：

- Harness 的核心复杂度在协议对象、模型输出兼容、UI 状态、Action Graph、Trace、Context Bundle 和 Adapter 语义上，TypeScript 的 schema 与前端共享收益更高。
- 模型 provider、toolCall、Web UI、Tauri、SDK 和文档样例都更容易在 TypeScript 中统一。
- 当前项目可参考代码也集中在 TypeScript。

Go 可以作为后续 executor worker 或 sandbox worker 的候选：

| 适用位置 | 使用条件 |
|---|---|
| 本地 daemon | 需要稳定长驻进程、进程管理、PTY、文件系统 watcher 和资源控制。 |
| Sandbox worker | 需要更强隔离、并发和系统调用控制。 |
| 高吞吐服务 worker | 执行层成为瓶颈，且边界已通过 Manifest/Action/Artifact 固定。 |

如果引入 Go，应保持 Runtime Kernel 和协议 schema 仍由 TypeScript 定义，Go worker 只消费 Manifest、Action 和 Artifact contract，返回 execution record。

## 5. 当前项目可借鉴部分

| 参考位置 | 可借鉴内容 | 新项目处理 |
|---|---|---|
| `packages/opencode/src/session/llm.ts` | provider 调用、toolCall carrier、模型 streaming、协议提示。 | 抽象为 Model Gateway，不让 Session 成为状态根。 |
| `packages/opencode/src/tool/tool.ts` | tool schema、permission、execute、result truncation。 | 保留 tool abstraction，接入 Action Executor contract。 |
| `packages/opencode/src/agent/agent.ts` | Agent registry、模板加载、配置覆盖。 | 升级为 Agent Template registry，明确 Agent Session 边界。 |
| `packages/opencode/src/agent/entry.ts` | primary、delegable、mentionable 等入口语义。 | 迁入 Agent entry metadata。 |
| `packages/opencode/src/server/server.ts` | Hono API、路由组织、服务启动。 | 作为 Runtime API 风格参考。 |
| `packages/opencode/src/protocol/schema.ts` | 协议 schema 与 parser 原型。 | 重写为当前 DSL：`kind/message/calls`、expanded executor class、canonical fields。 |
| `packages/opencode/src/workflow/*` | durable workflow runner 的执行经验。 | 改造成 Workflow Adapter，展开为 Harness Action Graph。 |
| `packages/app/src/pages/harness.tsx` | Harness UI 原型。 | 参考信息架构；新项目按 Projection/Trace/Command 模型重做。 |

新项目的状态根应是 Run、Action Graph、Event、Projection 和 Trace，而不是 chat session transcript。

## 6. Runtime Kernel 设计

### 6.1 核心服务

| 服务 | 责任 |
|---|---|
| Command Service | 接受 UI/API/CLI Command，做 schema、authority、gate 和 Projection 校验。 |
| Protocol Service | 解析模型 `act/answer/done`，处理 toolCall carrier 和 recovered request。 |
| Action Service | 创建 Action record，维护 Action Graph、dependencies、status 和 result policy。 |
| Policy Service | 处理 authority、permission、visibility、budget、resource 和 safety gate。 |
| Routing Service | 选择 executor，创建 Assignment 或 direct invocation。 |
| Scheduler | 调度 ready Action，控制 parallelism、resource lock、retry 和 cancellation。 |
| Executor Service | 管理 tool、agent、runtime、human、pipeline、service executor。 |
| Event Service | 追加 Event，提供 seq、idempotency、transaction 和 replay 支持。 |
| Projection Service | 由 Event 和 Materialized State 构建 Run、Action、Assignment、Workflow、UI Projection。 |
| Trace Service | 生成可读、可导出、可复用的证据链。 |
| Context Service | 构造 Context Bundle、Memory、Observation 和 semantic interpretation。 |
| Artifact Service | 存储、索引、脱敏、引用和清理 Artifact。 |

### 6.2 核心数据流

```txt
Command / ProtocolOutput / AdapterOperation
  -> normalize
  -> validate
  -> create Action / Event
  -> update Projection
  -> schedule ready Action
  -> route executor
  -> execute with Manifest
  -> store result / Artifact
  -> append Event
  -> update Projection and Trace
  -> construct Observation or UI update
```

## 7. 数据层设计

### 7.1 数据库策略

本地单用户版本使用 SQLite。团队或服务端版本使用 PostgreSQL。两者通过 Drizzle schema 共享表定义，差异通过 adapter 控制。

### 7.2 核心表

| 表 | 作用 |
|---|---|
| `runs` | Run metadata、goal、owner、status、created_at、updated_at。 |
| `actions` | Action record、operation、executor hint、status、dependencies、result policy。 |
| `action_edges` | Action Graph dependency edges。 |
| `assignments` | Agent Session assignment、contract、authority、status。 |
| `sessions` | Agent Session metadata、source agent、run/action relation、status。 |
| `events` | append-only accepted Event。 |
| `projections` | 当前操作视图 cache，按 run/action/session/workflow 分 namespace。 |
| `traces` | Trace entry、refs、visibility、summary。 |
| `artifacts` | Artifact Index record。 |
| `decisions` | human decision、approval、permission request 和结果。 |
| `agents` | Agent Template registry record、source、enabled、diagnostics。 |
| `memories` | Memory record、scope、namespace、status、evidence refs。 |
| `workflows` | Workflow Profile 和 adapter state。 |
| `manifests` | Executor environment manifest。 |
| `snapshots` | Workspace、artifact index、executor state 或 adapter state checkpoint。 |

### 7.3 事务原则

- Event append 和 Projection update 在同一个逻辑事务中处理。
- Event append 成功但 Projection update 失败时，Projection 标记 stale。
- 所有 state mutation 都可从 Event seq 定位。
- Adapter state 作为 Materialized State 参与 replay 和 recovery。

## 8. Model Gateway

Model Gateway 负责：

- provider/model catalog。
- toolCall carrier 注册。
- streaming response 解析。
- protocol output extraction。
- direct tool request recovery。
- model fallback。
- response cache。
- token/cost budget。
- Runtime Observation formatting。

Model Gateway 不直接改变 Harness 状态。它的输出进入 Runtime Protocol Service，再由 Runtime 决定是否接受。

## 9. Executor Layer

### 9.1 Tool Executor

Tool executor 需要：

- input schema。
- output schema 或 result classifier。
- permission declaration。
- side effect declaration。
- artifact policy。
- timeout 和 cancellation。
- logs 和 trace refs。

### 9.2 Agent Executor

Agent executor 由 Runtime 创建 Agent Session，并绑定：

- Assignment contract。
- authority。
- Context Bundle。
- model preference。
- session log。
- child session trace。

### 9.3 Human Executor

Human executor 表示需要用户或 Owner 决策。执行结果来自 Command，例如 `decision.answer` 或 `permission.approve`。

### 9.4 Runtime Executor

Runtime executor 处理内部确定性操作，例如 summarize、checkpoint、projection rebuild、merge artifacts、wait 和 export。

## 10. UI 架构

### 10.1 页面结构

| 页面 | 内容 |
|---|---|
| Run Console | Run list、Run detail、Action Graph、Assignment、Decision、Artifact、Trace。 |
| Session Workbench | root/child/descendant session tree、session log、Context Bundle、用户输入。 |
| Agent Manager | Agent 模板、entry、capability、permission、relationships、orchestration_policy。 |
| Protocol Panel | model declaration、recovered request、Action Graph、routing、Observation。 |
| Workflow Panel | Workflow Profile、DAG、node status、loop、gate、adapter recovery。 |
| Governance View | Authority、Memory、Concept、Redaction、Trace Export、Audit Evidence。 |

### 10.2 前端数据原则

- UI 默认读取 Projection。
- UI 展示 Event 和 raw logs 作为证据入口。
- UI 状态变更提交 Command。
- UI records 携带 id、status、summary、refs、evidence、actor、time、visibility 和 provenance。
- UI 支持多 Agent Session 切换和输入，不把所有交互压到 root session。

## 11. 部署形态

| 形态 | 描述 |
|---|---|
| Local Desktop | Tauri + local Runtime + SQLite + local artifact store。适合个人开发者。 |
| Local Server | HTTP Runtime + Web Console + SQLite/PostgreSQL。适合本地团队试用。 |
| Team Server | Web Console + PostgreSQL + object storage + auth + multi-user permission。 |
| Worker Adapter | 将特定 executor 或 monitor 放入 Cloudflare Workers、Durable Objects、Temporal 或其他外部运行环境。 |

## 12. 安全与权限

系统应覆盖：

- Workspace read/write scope。
- Tool permission。
- Network policy。
- Secret refs。
- Human approval gate。
- Redaction policy。
- Audit export。
- Model data visibility。
- External service allowlist。
- Agent assignment authority。

权限决策记录进入 Event 和 Trace。

## 13. 测试策略

| 层级 | 测试 |
|---|---|
| Schema | 协议对象、Action、Command、Event、Projection、Workflow Profile 的解析和拒绝样例。 |
| Runtime | Command -> Event -> Projection，Action Graph scheduling，Routing，Gate，Recovery。 |
| Executor | Tool/Agent/Human/Runtime executor 的 contract、permission、timeout 和 artifact。 |
| Context | Context Bundle、Memory scope、Visibility、Observation 和 redaction。 |
| UI | 关键流程 Playwright：创建 Run、进入 child session、审批、查看 trace、恢复。 |
| Adapter | Workflow DAG、loop、verification、failure、rehydration。 |

## 14. 技术风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 协议对象过早膨胀 | 字段太多会降低模型稳定输出质量。 | 模型侧保持 `kind/message/calls` 扁平；Runtime 内部展开。 |
| 状态模型复杂 | Event、Projection、Materialized State、Trace 容易职责混乱。 | 明确 Event 为历史、Projection 为操作视图、Materialized State 为持久化状态。 |
| 多 Agent 成本过高 | 并行 session 会增加模型和协调成本。 | Routing 前评估任务可分解、上下文可隔离、结果可聚合和成本收益。 |
| UI 误导状态 | UI 如果读取 transcript 会与 Runtime 状态不一致。 | UI 默认读取 Projection，状态变更通过 Command。 |
| Workflow 与基础 DSL 分裂 | 单独 workflow 协议会造成两套语义。 | Workflow Profile 展开为基础 Action Graph。 |
| Sandbox 不足 | 本地执行可能影响文件系统或 secret。 | 每次 executor invocation 绑定 Manifest 和 permission gate。 |

