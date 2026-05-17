# My Agent 开发计划

> 基于 opencode fork 的 Agent 系统开发规划
>
> 日期: 2026-05-15
> 版本: v2.0
>
> **核心决策**：直接 fork opencode 并修改，不使用插件机制

---

## 1. 架构决策

### 1.1 为什么选择 Fork

| 方案 | 优势 | 劣势 |
|------|------|------|
| **Fork + 修改 (选中)** | 完全自由、可删除不需要的功能、保留好东西 | 需要维护 fork |
| 插件方案 | 不改动核心 | 无法删除内置功能、无法完全控制 Session |
| 从头重写 | 完全干净 | 工作量大、丢失成熟生态 |

### 1.2 保留 vs 删除 vs 重写

| 模块 | opencode 现状 | 决策 | 理由 |
|------|-------------|------|------|
| **Agent 系统** | 硬编码内置 agents | **重写** | PRD 要求模板化、目录结构 |
| **Session 系统** | 数据库存储、状态管理 | **保留 + 扩展** | 已有实现，复用 |
| **Tool 工具链** | 完整的工具注册机制 | **保留** | 成熟稳定 |
| **MCP 集成** | MCP 生命周期管理 | **保留** | 完善 |
| **权限系统** | PermissionNext | **重写** | PRD 要求六维权限、Capability/Policy 分离 |
| **LSP 支持** | LSP 客户端集成 | **保留** | 成熟 |
| **Skill 系统** | skills/ 目录加载 | **删除** | PRD 不需要 |
| **Plugin 系统** | 插件加载机制 | **删除** | fork 后不需要 |
| **协议层** | 已有事件/HTTP API | **保留 + 扩展** | 兼容并扩展 PRD 协议 |
| **TUI 客户端** | 完整 TUI 实现 | **保留 + 扩展** | 复用 |
| **Web 客户端** | Web UI | **保留 + 扩展** | 复用 |

### 1.3 Fork 后的目标架构

```
my-agent (fork from opencode)
├── 删除
│   ├── src/skill/              # 删除 Skill 机制
│   ├── src/plugin/             # 删除 Plugin 系统
│   └── 内置硬编码 agents       # 删除 build/plan/general/explore 等
│
├── 保留 + 扩展
│   ├── src/session/            # Session 管理 (扩展状态机)
│   ├── src/tool/               # 工具链 (扩展工具描述)
│   ├── src/provider/           # 模型提供者
│   ├── src/server/             # HTTP/WebSocket 服务
│   ├── src/mcp/                # MCP 集成
│   ├── src/lsp/                # LSP 支持
│   ├── src/storage/            # 数据库存储
│   └── packages/*/             # TUI/Web/SDK
│
├── 重写
│   ├── src/agent/              # Agent 系统 (PRD 模板化)
│   ├── src/permission/         # 权限系统 (六维 + Capability/Policy)
│   ├── src/workflow/            # 工作流引擎 (DSL)
│   └── src/memory/             # 记忆系统 (四层)
│
└── 新增
    ├── config/agents/           # Agent 模板目录 (PRD)
    ├── config/workflows/        # Workflow DSL 文件
    └── config/prompts/         # 提示词模板
```

---

## 2. 模块依赖关系

```
┌─────────────────────────────────────────────────────────────────────┐
│                         需要重写的模块                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐  │
│  │   Agent     │     │  Permission  │     │      Memory         │  │
│  │   System    │────▶│   System    │     │      System        │  │
│  └─────────────┘     └─────────────┘     └─────────────────────┘  │
│        │                   │                       │                │
│        │                   │                       │                │
│        ▼                   ▼                       ▼                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Workflow Engine                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                     │
└──────────────────────────────│─────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         保留复用的模块                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │
│  │   Session   │  │    Tool     │  │    MCP      │  │  Server  │ │
│  │   System    │  │   Chain     │  │  Integration│  │  (HTTP/WS│ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └──────────┘ │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
│  │  Provider   │  │    LSP      │  │  Storage    │                │
│  │             │  │             │  │  (SQLite)   │                │
│  └─────────────┘  └─────────────┘  └─────────────┘                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 多期开发计划

### 第一期：核心基础 (Foundation)

**目标**: 重写 Agent 系统 + Session 扩展 + 基础权限

| 优先级 | 功能 | 说明 | 对应 PRD |
|--------|------|------|---------|
| P0 | Agent 系统重写 | 模板目录结构、identity/rules 分离 | FR-001~003 |
| P0 | Session 状态机 | 6 种状态 + Timeline Checkpoint | FR-004~006 |
| P0 | 权限系统重写 | Capability/Policy 双层模型 | FR-010~012 |
| P0 | 工具链保留 | 内置工具 + MCP 集成 | FR-007~009 |
| P1 | 工具权限绑定 | 工具调用前权限判定 | FR-010~012 |
| P1 | TUI 适配 | 修改 TUI 以支持新 Agent 系统 | FR-024~025 |

**里程碑**: 可运行的 Agent 系统，支持模板化 Agent 定义

**关键文件变更**:
```
删除:
  - src/agent/agent.ts (重写)
  - src/skill/ (删除)
  - src/plugin/ (删除)
  - 内置硬编码 agents

新增:
  - src/agent/template.ts      # Agent 模板加载
  - src/agent/identity.ts     # identity.md 解析
  - src/agent/rules.ts        # rules.md 解析
  - src/permission/capability.ts  # Capability 层
  - src/permission/policy.ts     # Policy 层
  - config/agents/               # Agent 模板目录

修改:
  - src/session/index.ts       # 扩展状态机
  - src/session/schema.ts     # 新增字段
```

---

### 第二期：协议与可观测性 (Protocol & Observability)

**目标**: 建立完整的协议系统和可观测性

| 优先级 | 功能 | 说明 | 对应 PRD |
|--------|------|------|---------|
| P0 | Event Gateway 扩展 | 有序事件流、replay 机制、DSL 事件 | FR-019 |
| P0 | 权限审批流 | Tool Call → Permission → User 审批 | FR-021 |
| P1 | Boot 管线 | Runtime 懒加载、启动进度 | FR-022 |
| P1 | REST API 扩展 | Session/Permission/Timeline API | FR-018, FR-020 |
| P1 | WebSocket 优化 | 断点续接、事件订阅 | FR-019 |
| P2 | 四类信号 | Events/Metrics/Traces/Audit | FR-027 |

**里程碑**: 完整的协议驱动的 Agent 系统，支持多客户端

---

### 第三期：记忆与工作流 (Memory & Workflow)

**目标**: 实现分层记忆和工作流编排

| 优先级 | 功能 | 说明 | 对应 PRD |
|--------|------|------|---------|
| P0 | 分层记忆系统 | working/episodic/semantic/procedural | FR-015~016 |
| P0 | Workflow DSL | 单 Agent 工作流定义与执行 | FR-034~036 |
| P1 | Memory Agent | 知识管家、Recall Gate、分类 | FR-017 |
| P1 | Orchestration | 多 Agent 编排 (sequential/parallel) | FR-034 |
| P2 | 经验学习 | 任务总结、策略沉淀 | FR-029~030 |
| P2 | 策略库 | candidate → active → deprecated | FR-029~030 |

**里程碑**: 支持工作流和记忆的智能 Agent 系统

---

### 第四期：渠道与评估 (Channel & Evaluation)

**目标**: 实现渠道对接和评估闭环

| 优先级 | 功能 | 说明 | 对应 PRD |
|--------|------|------|---------|
| P1 | IM 适配器 | 飞书/钉钉/企微对接 | FR-031 |
| P1 | 智能路由 | Collection 感知检索 | FR-032 |
| P2 | 定时调度 | 任务调度器 | FR-033 |
| P2 | 评估闭环 | 回归评估体系 | FR-026 |
| P2 | 模型治理 | 模型路由、fallback 链、token 统计 | FR-028 |

**里程碑**: 功能完整的专业 Agent 系统

---

## 4. 第一期详细任务

### Phase 1.1: 清理与准备 (1 周)

| 任务 | 描述 | 产出 |
|------|------|------|
| C-101 | Fork opencode 到 my-agent 仓库 | 新仓库 |
| C-102 | 删除 src/skill/ 目录 | 代码清理 |
| C-103 | 删除 src/plugin/ 目录 | 代码清理 |
| C-104 | 删除内置硬编码 agents | 代码清理 |
| C-105 | 创建 config/agents/ 目录结构 | 基础设施 |
| C-106 | 编写 CI/CD 验证清理完成 | 自动化测试 |

### Phase 1.2: Agent 系统重写 (2 周)

| 任务 | 描述 | 依赖 | 产出 |
|------|------|------|------|
| A-201 | 设计 Agent 模板 Schema | C-105 | `src/agent/schema.ts` |
| A-202 | 实现模板加载器 (目录扫描) | A-201 | `src/agent/loader.ts` |
| A-203 | 实现 identity.md 解析 | A-202 | `src/agent/identity.ts` |
| A-204 | 实现 rules.md 解析 | A-203 | `src/agent/rules.ts` |
| A-205 | 实现 meta.json 验证 | A-201 | `src/agent/meta.ts` |
| A-206 | 实现 Agent 注册表 | A-205 | `src/agent/registry.ts` |
| A-207 | 实现 Agent 切换逻辑 | A-206 | TUI 适配 |
| A-208 | 创建默认 Agent 模板 | A-206 | `config/agents/default/` |
| A-209 | 单元测试覆盖 | A-208 | 测试报告 |

### Phase 1.3: Session 状态机扩展 (1 周)

| 任务 | 描述 | 依赖 | 产出 |
|------|------|------|------|
| S-301 | 扩展 Session Schema (6 种状态) | - | `src/session/schema.ts` |
| S-302 | 实现状态转换逻辑 | S-301 | `src/session/state.ts` |
| S-303 | 实现 Timeline Checkpoint | S-302 | `src/session/timeline.ts` |
| S-304 | 实现 Workspace 绑定 | S-303 | `src/session/workspace.ts` |
| S-305 | 实现 dsl_context 字段 | S-304 | `src/session/dsl.ts` |
| S-306 | 数据库迁移 | S-305 | 新增字段 |
| S-307 | 单元测试覆盖 | S-306 | 测试报告 |

### Phase 1.4: 权限系统重写 (2 周)

| 任务 | 描述 | 依赖 | 产出 |
|------|------|------|------|
| P-401 | 设计 Capability Schema | - | `src/permission/capability.ts` |
| P-402 | 设计 Policy Schema | P-401 | `src/permission/policy.ts` |
| P-403 | 实现权限继承计算 | P-402 | `src/permission/inherit.ts` |
| P-404 | 实现六维权限控制 | P-403 | `src/permission/six-dim.ts` |
| P-405 | 实现权限判定接口 | P-404 | `src/permission/evaluate.ts` |
| P-406 | 集成到工具链 | P-405 | 工具调用前判定 |
| P-407 | 实现权限审批流 | P-406 | `waiting_permission` 状态 |
| P-408 | 单元测试覆盖 | P-407 | 测试报告 |

### Phase 1.5: TUI 适配 (1 周)

| 任务 | 描述 | 依赖 | 产出 |
|------|------|------|------|
| T-501 | 适配 Agent 列表显示 | A-206 | TUI 更新 |
| T-502 | 适配权限提示显示 | P-405 | TUI 更新 |
| T-503 | 适配 Session 状态显示 | S-302 | TUI 更新 |
| T-504 | 端到端测试 | T-503 | E2E 测试报告 |

---

## 5. Agent 模板目录结构

```
config/agents/
├── default/                    # 默认 Agent
│   ├── meta.json              # Agent 元数据
│   ├── identity.md            # 角色定义 (给模型读取)
│   └── rules.md               # 行为约束 (给模型读取)
│
├── planner/                   # 规划 Agent
│   ├── meta.json
│   ├── identity.md
│   └── rules.md
│
└── custom/                    # 用户自定义 Agent
    ├── meta.json
    ├── identity.md
    ├── rules.md
    └── workflow.yaml          # 可选: 工作流定义
```

### meta.json 示例

```json
{
  "id": "default",
  "name": "Default",
  "role": "assistant",
  "description": "The default assistant agent",
  "model_preference": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-7-20250514"
  },
  "workflow_mode": "none",
  "allowed_tools": ["read", "edit", "bash", "grep", "glob"],
  "denied_tools": [],
  "inherit_permissions": false,
  "permission_mode": "standard"
}
```

### identity.md 示例

```markdown
# 角色定义

你是一个专业的 AI 助手，专注于帮助用户完成软件开发任务。

## 核心职责
- 理解和分析用户需求
- 编写高质量代码
- 调试和修复问题
- 代码审查和优化

## 与用户的关系
- 你是工具，用户是决策者
- 重要操作前必须确认
- 保持透明，说明正在做什么
```

### rules.md 示例

```markdown
# 行为约束

## 必须遵守
1. 每次修改前先读取文件，了解现有代码
2. 使用版本控制，每次重要变更提交
3. 编写测试确保代码质量
4. 遵守项目的代码风格

## 禁止行为
1. 禁止删除未备份的重要文件
2. 禁止执行未经用户确认的危险命令
3. 禁止泄露敏感信息

## 工作方式
1. 先规划，再执行
2. 小步提交，及时反馈
3. 复杂问题拆解处理
```

---

## 6. 评估指标

### 6.1 第一期验收标准

| 指标 | 目标值 | 测量方法 |
|------|--------|----------|
| Agent 创建时间 | < 100ms | 性能测试 |
| Session 创建时间 | < 500ms | 性能测试 |
| 权限判定时间 | < 200ms | 性能测试 |
| 工具调用成功率 | > 95% | 集成测试 |
| 代码覆盖率 | > 80% | 测试报告 |
| E2E 测试通过率 | 100% | 自动化测试 |

### 6.2 架构合规性检查

- [ ] Agent 定义符合 PRD 术语基线
- [ ] Session 状态机覆盖全部 6 种状态
- [ ] 权限继承计算正确实现
- [ ] 协议层支持断点续接
- [ ] TUI/Web 消费同一协议
- [ ] Skill/Plugin 系统已删除

---

## 7. 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Bun | opencode 使用，已有成熟生态 |
| 语言 | TypeScript | opencode 一致 |
| 数据库 | SQLite | 轻量、可持久化 |
| WebSocket | ws | opencode 已使用 |
| 配置验证 | Zod | opencode/oh-my-openagent 已用 |
| 测试 | Bun test | opencode 一致 |
| 构建 | Turso | opencode 一致 |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Fork 同步上游困难 | 中 | 选择性同步，定期合并 |
| 删除 Skill/Plugin 影响其他功能 | 高 | 充分测试，确保无依赖 |
| Agent 模板系统兼容性 | 中 | 先行验证 POC |
| 性能回退 | 中 | 持续性能测试 |
| 破坏现有 TUI/Web | 高 | E2E 测试覆盖 |

---

## 9. 下一步行动

### 立即开始
1. Fork opencode 仓库
2. 删除 Skill/Plugin 模块
3. 创建 Agent 模板目录结构
4. 实现 Phase 1.2 Agent 系统重写

### 第一期时间线 (6 周)

| 周次 | 内容 |
|------|------|
| Week 1 | Phase 1.1 清理与准备 |
| Week 2-3 | Phase 1.2 Agent 系统重写 |
| Week 4 | Phase 1.3 Session 状态机扩展 |
| Week 5-6 | Phase 1.4 权限系统重写 |
| Week 6 | Phase 1.5 TUI 适配 + 验收 |

---

## 10. PRD 功能映射表

| PRD 编号 | 功能 | 实现阶段 | 实现位置 |
|----------|------|---------|---------|
| FR-001 | Agent 模板定义 | Phase 1.2 | src/agent/ |
| FR-002 | Workflow 程序门禁 | Phase 3 | src/workflow/ |
| FR-003 | 配置系统 | Phase 1.2 | config/agents/ |
| FR-004 | Session 状态机 | Phase 1.3 | src/session/ |
| FR-005 | Workspace 绑定 | Phase 1.3 | src/session/workspace.ts |
| FR-006 | Timeline Checkpoint | Phase 1.3 | src/session/timeline.ts |
| FR-007 | 统一工具链 | 保留 | src/tool/ |
| FR-008 | MCP 集成 | 保留 | src/mcp/ |
| FR-009 | 核心工具集 | 保留 | src/tool/ |
| FR-010 | 双层权限模型 | Phase 1.4 | src/permission/ |
| FR-011 | 权限继承 | Phase 1.4 | src/permission/inherit.ts |
| FR-012 | 六维权限 | Phase 1.4 | src/permission/six-dim.ts |
| FR-013 | Sync/Async 调用 | Phase 1.3 | src/session/ |
| FR-014 | 状态区分 | Phase 1.3 | src/session/state.ts |
| FR-015 | 分层记忆 | Phase 3 | src/memory/ |
| FR-016 | Collection 分区 | Phase 3 | src/memory/collection.ts |
| FR-017 | Memory Agent | Phase 3 | src/memory/agent.ts |
| FR-018 | Canonical Protocol | Phase 2 | src/server/ |
| FR-019 | Event Gateway | Phase 2 | src/server/events.ts |
| FR-020 | 双端协议同构 | Phase 2 | src/server/ + packages/ |
| FR-021 | 权限审批流 | Phase 1.4 | src/permission/ |
| FR-022 | Boot 管线 | Phase 2 | src/server/boot.ts |
| FR-023 | 打断机制 | Phase 2 | src/session/ |
| FR-024 | Workbench 设计 | Phase 1.5 | packages/tui/ |
| FR-025 | 双端同构 | Phase 2 | packages/tui/ + packages/web/ |
| FR-026 | 评估闭环 | Phase 4 | src/evaluation/ |
| FR-027 | 四类信号 | Phase 2 | src/observability/ |
| FR-028 | 模型治理 | Phase 4 | src/provider/ |
| FR-029 | 策略沉淀 | Phase 3 | src/memory/strategy.ts |
| FR-030 | 错误模式规避 | Phase 3 | src/memory/error.ts |
| FR-031 | IM 适配器 | Phase 4 | src/channel/ |
| FR-032 | 智能路由 | Phase 4 | src/routing/ |
| FR-033 | 定时调度 | Phase 4 | src/scheduler/ |
| FR-034 | 编排模式 | Phase 3 | src/workflow/orchestration.ts |
| FR-035 | 错误处理 | Phase 3 | src/workflow/error.ts |
| FR-036 | 统一 DSL 语法 | Phase 3 | src/workflow/dsl.ts |

---

*文档版本: v2.0*
*创建日期: 2026-05-15*
*下次审查: 2026-05-22*
