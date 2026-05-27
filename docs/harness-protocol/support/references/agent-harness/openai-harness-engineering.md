# OpenAI：Harness engineering

- 来源：https://openai.com/index/harness-engineering/
- 标题：Harness engineering: leveraging Codex in an agent-first world
- 发布方：OpenAI
- 作者：Ryan Lopopolo
- 发布时间：2026-02-11
- 抓取时间：2026-05-27

## 内容定位

这篇文章不是协议文档，而是 OpenAI 在 Codex 驱动软件工程中的实践总结。它讨论当工程团队把主要产出交给 agent 后，团队需要如何重构仓库、文档、工具、验证、可观测性和架构约束。

## 主要观点

- 工程师的工作从直接写代码转向设计环境、描述意图、提供反馈循环和建立可执行约束。
- 仓库知识应成为系统事实来源。短 `AGENTS.md` 作为入口和目录，深入规则、架构、计划、质量标准和产品原则放在结构化 `docs/` 中。
- Agent 可读性是关键目标。UI、日志、指标、trace、测试、文档和架构规则都需要变成 agent 可以读取、验证和操作的对象。
- 复杂系统需要机械化边界。架构约束、依赖方向、schema、日志、命名、文件大小、可靠性规则等应通过 lint、CI、脚本和结构化测试执行。
- 评审、测试、验证、反馈处理和恢复循环可以逐步编码进系统，使 agent 能端到端推进较大功能。
- Agent 高吞吐会放大熵增问题，因此需要持续的文档修复、质量检查和小步重构机制。

## 对 Open Agent Harness 的启发

- 该文支持我们把 UI、trace、artifact、event、projection、context 和 docs 都视为 Harness 的可治理对象。
- `AGENTS.md` 作为入口、`docs/` 作为事实来源的模式，适合映射到本协议中的 Context Bundle、Memory、Concept 和 Artifact。
- OpenAI 更强调工程组织方法和 agent-first repo operating model；我们的协议需要进一步抽象为通用 Runtime 治理协议。
- 该文强烈支持 `Verification`、`Gate`、`Review`、`Artifact evidence` 和 `Projection` 的总纲地位。
- 后续子协议可以吸收它的“可读性”观点：所有 Runtime 产物都应被 agent、UI 和审计系统以稳定结构读取。

