# Open Agent Harness

Open Agent Harness 是一个面向协议驱动编程 agent 的 source-available 运行时。它基于 opencode 源代码树改造，保留了 opencode 作为本地编程环境的核心优势，同时围绕 harness 重塑 agent 层：在这个受管理的空间里，agent、工具、请求和运行时状态可以被描述、路由、观测和组合。

核心想法很简单：创建一个 agent 应该像创建一个 skill 一样轻量。skill 不应该只是散落在系统旁边的一段松散提示词。在 Open Agent Harness 中，skill 会成为具备明确契约、请求形态、工具边界和协作规则的一等 agent。

## 改了什么

Open Agent Harness 聚焦四个设计方向：

- 重写工具调用机制，让工具执行由 harness 管理，而不是被视为模型产生的黑盒副作用。
- 重新定义请求格式，让 agent 输入、工具意图、运行时上下文和协调元数据可以一起传递。
- 将 skill 转换为一等 agent，使创建 agent 像编写 skill 一样简单、可重复。
- 设计一套多 agent 管理协议，用于在受控 harness 环境中处理路由、委派、状态共享、审查和交接。

目标不只是运行一个编程 agent。目标是让 agent 协作足够清晰，使运行时能够监督它。

## Harness 理念

agent 应该小而具名，并且容易理解。每个 agent 都应该知道自己的角色、可用工具、输入契约和输出契约。harness 负责协调这些 agent，同时不隐藏工作在系统中流经的路径。

工具调用应该是结构化 action，而不只是模型输出的字符串。一次工具调用包含权限、作用域、输入、输出、错误和审计历史。Open Agent Harness 将这些结构视为运行时协议的一部分。

多 agent 系统应该像操作环境一样被设计。harness 定义 agent 如何被创建、如何协作、如何请求帮助、如何交接工作，以及之后如何检查它们完成工作的过程。

## 状态

当前仓库是一个改造后的 opencode 代码库。公开身份、包名、CLI 入口、许可证和文档已经改为 Open Agent Harness；迁移过程中，一些内部 workspace 包名和兼容路径仍可能引用 opencode。

## 目录结构

本仓库是一个 Bun monorepo。迁移过程中，主运行时包仍位于 `packages/opencode`。

| 路径 | 用途 |
| --- | --- |
| `packages/opencode` | Open Agent Harness 主运行时、CLI、server、session 系统、agent registry、工具执行、ACP 支持和协议实现。 |
| `packages/app` | 浏览器和桌面客户端共用的 Solid/Vite Web UI。 |
| `packages/desktop` | 基于 Tauri 的桌面壳，包装共享 app。 |
| `packages/desktop-electron` | Electron 桌面壳。 |
| `packages/sdk` | OpenAPI 定义和生成的 SDK 产物。JavaScript SDK 使用 `./packages/sdk/js/script/build.ts` 重新生成。 |
| `packages/web` | 从上游继承的 Astro/Starlight 文档站点。发布前仍需要产品范围审查。 |
| `packages/docs` | 从上游继承的 Mintlify 文档工作区。当前还不是 canonical docs surface。 |
| `packages/plugin`, `packages/script`, `packages/ui`, `packages/util` | 从上游继承的 workspace 支撑包。部分包名仍因兼容性保留 `@open-agent-harness/*`。 |
| `github` | GitHub Action 集成包。当前触发兼容性仍可能包含 legacy `/opencode` 行为。 |
| `sdks/vscode` | VS Code extension 包，用于从编辑器启动和使用 harness。 |
| `docs` | 迁移计划、架构说明、bugfix 记录、审计和协议设计材料。 |
| `infra` | 从上游 console/cloud surface 继承的基础设施定义。生产使用前需要审查。 |
| `.github` | GitHub 仓库自动化。当前只保留低风险 CI workflow；发布、部署、签名、bot、通知和自动修改 issue/PR 的 workflow 已移除，等待 Open Agent Harness 发布方案。 |
| `.husky` | 本地 Git hooks。pre-push hook 会检查 Bun 版本，并执行包级 typecheck。 |

## AI Agent 行为准则

在本仓库工作的 AI agent 应优先保证正确性、可追踪性和迁移安全。

- 将 Open Agent Harness 视为产品身份。只有在说明上游来源、兼容路径或尚未迁移的内部名称时，才提及 opencode。
- 保留用户改动。不要回滚工作树中的无关修改；编辑已有改动附近代码前，先检查文件当前状态。
- 控制变更范围。不要顺手做无关重构，除非它直接降低当前任务的风险。
- 遵循 [AGENTS.md](./AGENTS.md) 中的风格规则。尤其是优先使用 Bun API、避免 `any`、避免不必要的解构、优先 early return，并在清晰的前提下使用短标识符。
- 从 package 目录运行检查，不要从仓库根目录运行测试。比如在 `packages/opencode` 或 `packages/app` 内执行 `bun typecheck`。
- API 或协议变更后，用 `./packages/sdk/js/script/build.ts` 重新生成 SDK 产物。
- 保持生成文件与源码同步。除非是在修复生成器本身，不要手动改生成的 SDK 文件。
- 没有明确的 Open Agent Harness 发布决策前，不要重新引入上游发布、部署、签名、文档翻译或 bot 自动化。
- 不要新增项目级 `.opencode` agent、command 或 tool 配置，除非仓库明确要发布这类配置。
- 明确说明兼容名称。如果文件仍需要 `packages/opencode`、`OPENCODE_*`、`.opencode`、`@open-agent-harness/*` 或 `/opencode`，需要说明它是迁移约束还是公开行为。

## 安装

```bash
bun install
bun run --cwd packages/opencode --conditions=browser ./src/index.ts --help
```

本地开发时，可以直接运行主包：

```bash
bun run --cwd packages/opencode --conditions=browser ./src/index.ts --help
```

## 许可证

Open Agent Harness 使用 GNU Affero General Public License v3.0 分发，采用与 MinIO 相同的开源许可模式。Open Agent Harness 版权所有方可以另行提供商业授权例外。

本项目包含派生自 opencode 的源代码，opencode 最初以 MIT License 分发。原始 opencode 版权声明和 MIT 许可证文本保留在 [LICENSE](./LICENSE) 中。

Open Agent Harness 不是由 OpenCode 团队构建，也不隶属于 OpenCode、opencode.ai 或 anomalyco。

## 第三方许可证

运行时依赖 MIT、Apache-2.0、BSD-3-Clause、ISC、BlueOak-1.0.0 以及相关宽松许可证下的第三方包。当前依赖许可证清单及引入这些许可证的模块见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
