# Agent Harness Engineering: A Survey

- 论文主页：https://picrew.github.io/LLM-Harness/
- OpenReview：https://openreview.net/forum?id=3hXEPbG0dh
- 项目页 OpenReview 链接：https://openreview.net/forum?id=eONq7FdiHa
- PDF：https://picrew.github.io/LLM-Harness/main.pdf
- GitHub catalog：https://github.com/Picrew/awesome-agent-harness
- HuggingFace dataset：https://huggingface.co/datasets/ChenLiu1996/Agent-Harness-Engineering
- 发布时间：2026-05-14，OpenReview 页面显示 2026-05-25 有修改。

## 内容定位

这是一篇 Agent Harness 方向的系统综述。它把 harness 定义为包裹语言模型、管理长任务执行的基础设施层，并试图用统一分类法连接研究论文、开源系统和生产工程实践。

## 核心贡献

- 提出 binding-constraint thesis：在长任务 Agent 中，可靠性差异不只由模型决定，harness 质量会显著影响最终表现。
- 提出 ETCLOVG 七层分类：Execution environment、Tool interface、Context management、Lifecycle/Orchestration、Observability、Verification、Governance。
- 将 170+ 开源 agent-harness 项目映射到该分类，分析生态覆盖和缺口。
- 总结跨层问题：cost-quality-speed trilemma、capability-control tradeoff、harness coupling problem。
- 提出开放问题：执行环境安全与可移植、长任务可靠状态、trace-native failure diagnosis、跨 agent/tool/human 标准 handoff、随模型能力提升自适应简化。

## 与本协议的关系

Open Agent Harness 的总纲已经覆盖 Model、Runtime、Agent Session、State、Adapter、UI 等协议对象。该综述对我们最有价值的是提供了另一套外部验证框架：

- Execution 对应 Execution Layer、Executor、sandbox/workspace contract。
- Tooling 对应 Action、toolCall normalization、Executor contract、MCP / tool protocol。
- Context 对应 Context Bundle、Memory、Visibility Policy、Semantic interpretation。
- Lifecycle 对应 Run、Assignment、Workflow adapter、Decision、Trigger。
- Observability 对应 Event Log、Trace、Artifact、Projection、export。
- Verification 对应 Gate、Review、Verification、evaluation loop adapter。
- Governance 对应 Authority、Scope、Command、approval、audit。

后续协议细化时，可以用 ETCLOVG 检查是否遗漏了生产级 Harness 的关键层。

