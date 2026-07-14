# Planner 团队文档与 Session Runs

## 用户目标

强化 `default`、`milestone-planner` 和 `feature-planner` 的团队协作行为。复杂任务应先按不同类型的子任务组建分析、设计和审查团队，复核后的需求、设计、计划与审查结果写入当前项目 `.harness/`，再由依赖这些文档的子会话执行。

同时在会话区域顶部的 Timeline、Logs 旁增加 Runs 入口，展示当前会话的协议 Runs、任务内容和规划文档，并支持点击 Markdown 文档查看全文。

## 已确认范围

- 复杂任务默认采用团队协作，不把多个专业领域交给一个通用 Agent 独立分析、设计和审查。
- planner 先判断任务是否包含不同类型、不同专业领域或不同验收路径的子任务。
- 每个子任务分别选择需求、领域、验收及相关工程专业 Agent。
- planner 汇总专业结论后，按子任务生成需求、设计和计划文档。
- 文档生成后调用与内容匹配的检查 Agent，修正重要问题，必要时再次复核。
- 最终文档由 `docs-maintainer` 写入 `.harness/`，并由 `docs-maintainer-verifier` 验证。
- 实现子会话依赖文档验证动作完成，通过明确的文档路径读取上下文。
- `.harness/` 加入 `.gitignore`，作为本地运行产物。
- Runs 页面只展示当前会话的 Agent Protocol Runs，不混入全局 Harness v2 Runs。

## 文档目录

```text
.harness/
└── sessions/
    └── <session_id>/
        └── runs/
            └── <review_run_id>/
                ├── requirements/<task_id>.md
                ├── designs/<task_id>.md
                ├── plans/<task_id>.md
                ├── reviews/<task_id>.md
                └── manifest.md
```

`review_run_id` 是最后一次完成文档专业审查的 planner Run ID。`manifest.md` 记录任务、文档类型、相对路径、共享文档和下游 Agent 的对应关系。

## Planner 流程

1. 判断任务复杂度和子任务类型。
2. 为每个子任务选择需求分析、专业设计和验收团队。
3. 并行处理互不依赖的分析，保留真实依赖。
4. 按子任务形成结构化 Markdown 草稿。
5. 为每份文档选择需求、路由、设计、测试及专项检查 Agent。
6. 修正检查问题，重要边界变化时重新复核。
7. 调用 `docs-maintainer` 写入约定目录。
8. 调用 `docs-maintainer-verifier` 验证文件、路径及内容。
9. 下游执行动作依赖文档验证完成，只接收自己的文档路径和必要共享文档。

简单、单一专业面、低风险且不需要持久规划文档的任务可以直接路由。复杂任务不得以节省调用为由跳过团队分析或独立审查。

## Runs 后端接口

- `GET /session/:sessionID/runs`：列出当前会话持久化的协议 Runs 和任务摘要。
- `GET /session/:sessionID/runs/:runID`：读取一个 Run 的完整任务内容。
- `GET /session/:sessionID/runs/:runID/documents`：列出约定目录下的 Markdown 文档。
- `GET /session/:sessionID/runs/:runID/document?path=...`：读取一个 Markdown 文档全文。

接口只允许访问当前项目 `.harness/sessions/<session_id>/runs/<run_id>/`，拒绝非法 session/run 标识、绝对路径、路径穿越、非 Markdown 文件、多层文档路径、符号链接和目录逃逸。

## Runs 界面

- 在桌面会话顶部显示 `Timeline | Logs | Runs`。
- Runs 页面默认选择当前或最近的 Run。
- 展示 Run 名称、ID、状态、时间、已完成数和总任务数。
- 展示任务标题、类型、目标 Agent、目标或 prompt、依赖、状态、摘要和错误。
- 文档按 requirements、designs、plans、reviews 和 manifest 分类。
- 点击文档在 Runs 页面内显示 Markdown 全文，可返回列表或切换文档。
- 提供加载中、空状态、刷新和读取错误反馈。

## 影响模块

- `.gitignore`
- `packages/opencode/config/agents/default/`
- `packages/opencode/config/agents/milestone-planner/`
- `packages/opencode/config/agents/feature-planner/`
- `packages/opencode/config/protocol/planner-protocol.md`
- `packages/opencode/src/session/`
- `packages/opencode/src/server/routes/session.ts`
- `packages/sdk/`
- `packages/app/src/pages/session.tsx`
- 新增的 Runs 面板组件与测试
- `docs/harness-module/`

## 验证计划

- 重新生成内置 Agent 清单和 JavaScript SDK。
- 从 `packages/opencode` 运行 Agent loader、Session Runs 路由和路径安全聚焦测试。
- 从 `packages/opencode` 运行 `bun typecheck`。
- 从 `packages/app` 运行 Runs 组件相关测试和 `bun typecheck`。
- 从 `packages/app` 运行 `bun test:e2e:local -- app/smoke.spec.ts`。
- 运行 `git diff --check`。

## 非目标

- 不修改 Agent Protocol DSL schema。
- 不把 `.harness` 运行文档加入 Git 提交。
- 不把全局 Harness v2 Runs 当作当前会话的协议 Run。
- 不允许 Runs 文档查看接口读取 `.harness` 之外的文件。
