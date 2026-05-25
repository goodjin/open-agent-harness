# Harness Console 四阶段开发计划总览

## 目标

新增一个独立的 Harness Console，用来管理多会话 Agent Run。旧界面保持不变，新界面通过新增 Harness API 读取和操作结构化状态。

Harness Console 的核心对象不是聊天消息，而是：

- Run
- Task
- Assignment
- Agent Session
- Artifact
- Gate
- Decision
- Event
- Memory
- Concept

## 设计边界

- 不重写旧聊天界面。
- 不让前端直接修改状态文件或数据库。
- 所有用户操作都通过 Command 或受控 Action API 进入 Runtime。
- 第一版 UI 以表格、列表、详情面板为主，DAG 图和 Concept 图后置。
- Project Memory 放在项目本地 Harness Store，Team/Global Memory 通过 Memory Service 引用，不混入项目目录。

## 总体架构

```txt
旧 UI
  -> 现有 session/message/tool API

Harness Console
  -> Harness API
  -> Harness Runtime
  -> Command/Event/Projection/Gate
  -> run-scoped store + governance store

共享底层
  -> provider / tool / workspace / storage / permission
```

## 四个阶段

### 阶段一：只读控制台

目标：让用户能打开新界面，看见 Run、Task、Artifact、Decision、Event 的结构化状态。

交付物：

- Harness 数据模型最小读接口
- Run 列表
- Run 详情
- Task 列表
- Artifact 列表
- Decision 列表
- Event 列表

计划文档：`01-phase-readonly-console.md`

### 阶段二：可操作控制台

目标：用户能通过 UI 发起受控操作，例如创建 Run、暂停、恢复、取消、重试、回答决策。

交付物：

- Command API
- Run 操作
- Task 操作
- Decision Answer
- Verification Rerun
- 基础权限与 Gate 校验

计划文档：`02-phase-operable-console.md`

### 阶段三：Harness 治理能力

目标：把 Memory、Concept、Authority、Gate Detail 引入控制台，让用户能理解项目状态、权限边界和概念变更影响。

交付物：

- Memory Query
- Project/Team/Global Memory Scope 展示
- Concept Detail
- Concept Replacement Request
- Impact Scan
- Authority View
- Gate Detail

计划文档：`03-phase-governance-console.md`

### 阶段四：可视化增强与审计

目标：增强可观察性和可审计性，支持图形化 DAG、Concept Graph、Event Replay 和 Run Comparison。

交付物：

- Task Graph 视图
- Concept Graph 视图
- Event Explorer
- Projection Rebuild 调试入口
- Run Comparison
- 审计导出

计划文档：`04-phase-visualization-audit.md`

## 前后端分工

### 后端

- 定义 Harness schema。
- 提供 Harness API。
- 实现 Command 校验。
- 维护 Event Log 和 Projection。
- 暴露 run-scoped 与 governance-scoped store。
- 和现有 session/tool/storage 兼容。

### 前端

- 新增独立 Harness Console 路由。
- 构建对象导航、列表、详情面板。
- 以 Projection 为主显示当前状态。
- 对操作生成 Command，不直接改状态。
- 把 Decision Request 展示成人类可读的选项。

### 集成测试

- API contract 测试。
- Harness Console 页面渲染测试。
- Command -> Event -> Projection 状态链路测试。
- Decision Answer 和 Task Retry 的端到端测试。

## 验收标准

- 旧 UI 行为不变。
- 新 UI 可以独立进入。
- 所有状态变化都经过 Runtime。
- 用户能看到 Run 当前状态、阻塞点、证据和待决策项。
- 前端不依赖自然语言 transcript 推断状态。
