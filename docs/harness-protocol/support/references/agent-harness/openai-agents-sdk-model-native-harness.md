# OpenAI：Agents SDK model-native harness

- 来源：https://openai.com/index/the-next-evolution-of-the-agents-sdk/
- 标题：The next evolution of the Agents SDK
- 发布方：OpenAI
- 发布时间：2026-04-15
- 抓取时间：2026-05-27

## 内容定位

这篇文章介绍 OpenAI Agents SDK 的新 harness 和 sandbox 能力。它比 Harness engineering 更接近运行层设计，重点是 model-native harness、sandbox execution、workspace manifest、durable execution 和 harness / compute separation。

## 主要观点

- Agent 需要标准化基础设施支持文件检查、命令执行、代码编辑、工具使用和长任务。
- SDK 提供 model-native harness，让 agent 以更贴近模型能力的方式跨文件、工具和计算环境工作。
- Harness 包含 configurable memory、sandbox-aware orchestration、filesystem tools、MCP、skills、AGENTS.md、shell、apply patch 等 primitives。
- Sandbox 是受控执行环境，提供文件、工具、依赖和安全边界。
- Manifest 用于描述 workspace、挂载文件、输出目录和外部存储数据，使 agent 在不同 sandbox provider 之间获得一致环境。
- Harness 与 compute 分离有三个作用：降低凭证暴露风险、支持 durable execution、允许多 sandbox / subagent / parallel container 执行。
- Agent 状态外部化后，sandbox 失败不等于 run 失败，可以通过 snapshot 和 rehydration 恢复。

## 对 Open Agent Harness 的启发

- 这篇文章与我们的分层边界高度相关：Model、Runtime、Execution、State、Adapter、Product 应保持清晰接口。
- `Manifest` 可以作为后续 `Executor` / sandbox / environment contract 的参考。
- Harness 与 compute 分离支持我们把 Agent Session、Executor、Tool、Runtime Service、External Service 和 Human 统一纳入 Executor 抽象。
- Durable execution 支持我们继续细化 Event Log、Projection、Materialized State、replay、snapshot、rehydration 之间的关系。
- OpenAI 的 model-native harness 提醒我们：DSL 需要适配模型现有能力，因此 toolCall carrier 作为协议载体是现实必要的兼容路径。

