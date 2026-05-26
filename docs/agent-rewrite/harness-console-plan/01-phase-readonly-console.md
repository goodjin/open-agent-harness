# 阶段一：只读 Harness Console

## 目标

建立独立新界面的最小可见版本。用户可以查看 Harness Run 的结构化状态，但暂不执行高风险操作。

本阶段回答：

- 当前有哪些 Run？
- 某个 Run 到哪一步了？
- 有哪些 Task、Artifact、Decision、Event？
- 哪些状态来自 Projection，而不是聊天 transcript？

## 交付物类型

- 后端：interface
- 前端：presentation
- 集成测试：interface + presentation

## 后端工作

### T-01 定义 Harness 只读 schema

范围：

- Run summary
- Run detail
- Task summary
- Assignment summary
- Artifact summary
- Decision summary
- Event summary
- Projection envelope

建议文件：

- `packages/opencode/src/harness/schema.ts`
- `packages/opencode/src/harness/index.ts`

验收：

- schema 能表达最小只读控制台需要的数据。
- 每个对象包含 `id`、`status`、`created_at`、`updated_at` 或等价字段。
- Projection envelope 能说明数据来源和更新时间。

### T-02 实现只读 Harness Store

范围：

- 读取 `.opencode/harness/runs/<run>/run.json`
- 读取 tasks/artifacts/decisions/events/projections
- 不实现写入操作
- 缺失目录时返回空集合

建议文件：

- `packages/opencode/src/harness/store.ts`

验收：

- 没有 Harness 数据时 API 返回空列表，不报错。
- 有 fixture 数据时能稳定读取。
- 不修改现有 session storage。

### T-03 暴露只读 Harness API

接口：

```txt
GET /harness/runs
GET /harness/runs/:id
GET /harness/runs/:id/tasks
GET /harness/runs/:id/assignments
GET /harness/runs/:id/artifacts
GET /harness/runs/:id/decisions
GET /harness/runs/:id/events
```

建议文件：

- `packages/opencode/src/server/harness.ts`
- 按现有 server 路由模式接入

验收：

- API 返回结构化 JSON。
- 错误对象格式与现有 API 风格一致。
- 不影响旧 UI 所用接口。

## 前端工作

### T-04 新增 Harness Console 路由入口

范围：

- 新增独立页面，不嵌入旧聊天主界面。
- 页面包含左侧导航和主内容区。

建议文件：

- `packages/app/src/pages/harness.tsx` 或符合现有路由结构的等价文件
- `packages/app/src/pages/harness.css`

验收：

- 用户能打开 Harness Console。
- 旧页面入口和行为不变。
- 页面空状态清晰显示“暂无 Run”。

### T-05 实现 Runs 列表

显示字段：

- Run name
- status
- goal
- progress
- active assignments
- pending decisions
- updated time

验收：

- 用户能看到所有 Run。
- 点击 Run 进入详情。
- 状态颜色稳定，不因文本长度导致布局跳动。

### T-06 实现 Run Detail 只读视图

模块：

- Goal Contract
- Task List
- Active Assignments
- Pending Decisions
- Recent Events
- Artifacts

验收：

- 用户能在一个页面了解 Run 当前状态。
- 详情数据来自 Harness API。
- 加载、空态、错误态都有明确 UI。

### T-07 实现基础对象详情面板

支持对象：

- Task
- Artifact
- Decision
- Event

验收：

- 点击列表项后右侧显示详情。
- Artifact 显示 kind、path、source task、created event。
- Event 显示 type、actor、timestamp、payload 摘要。

## 集成测试

### T-08 只读 API contract 测试

位置：

- `packages/opencode/test/harness/read-api.test.ts`

验收：

- 空 store 返回空列表。
- fixture store 返回预期 Run/Task/Artifact。
- 非法 run id 返回规范错误。

### T-09 Harness Console 渲染测试

位置：

- `packages/app/e2e/harness/readonly.spec.ts`

验收：

- 页面能显示 Runs 列表。
- 点击 Run 后显示 Task、Artifact、Decision。
- 空态页面可见。

## 风险

- 现有 server 路由结构可能不适合直接新增 `/harness`。
- `.opencode/harness` 目录位置需要和现有 workspace/root 规则对齐。
- 如果后端没有 fixture，前端开发会被阻塞；本阶段应先提供静态 fixture 或 dev seed。

## 完成标准

- 新界面可打开。
- 用户能只读查看 Run 结构化状态。
- 旧界面不受影响。
- 测试覆盖 API 和页面基本渲染。
