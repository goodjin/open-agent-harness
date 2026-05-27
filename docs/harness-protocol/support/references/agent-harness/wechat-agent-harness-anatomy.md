# 微信文章：深度“解剖”AI Agent Harness

- 来源：https://mp.weixin.qq.com/s/pKAr2hX4LfhUMMeev0HU1w
- 标题：深度“解剖”AI Agent Harness
- 公众号：老纪的技术唠嗑局
- 抓取时间：2026-05-27
- 页面发布时间：2026-05-25
- 文章线索：该文主要转述和整理 Akshay Pachaar 的 X 长文《The Anatomy of an Agent Harness》。
- 原文链接：https://x.com/akshay_pachaar/status/2041146899319971922

## 内容定位

这篇文章是面向工程读者的 Agent Harness 综述，核心观点是：模型本身不是完整 Agent，模型外部的编排、工具、记忆、上下文、状态、安全和验证系统才让模型具备可执行能力。

文章采用“组件解剖”的方式讲 Harness，重点是生产级 Agent 系统通常需要哪些基础设施组件，以及这些组件如何围绕模型形成运行循环。

## 主要观点

- Harness 是模型外部的完整软件基础设施，覆盖 orchestration loop、tools、memory、context management、state persistence、error handling、guardrails、verification loops、subagent orchestration 等。
- Agent 是用户感知到的行为形态；Harness 是产生这种行为的工程系统。
- 一个简单 ReAct / TAO loop 上生产后会暴露上下文腐烂、工具失败、状态丢失、错误累积、安全失控、验证不足等问题。
- 工具调用需要 schema、参数校验、权限检查、沙箱执行、结果捕获和 observation 格式化。
- 记忆不能直接等同事实，行动前仍需要根据当前环境状态验证。
- 上下文管理需要压缩、观察掩码、即时检索、子智能体摘要等策略。
- 生产级 Harness 需要错误分类、重试策略、人类介入、护栏、安全执行和验证循环。
- 多 Agent 编排只有在任务可并行、工具域分离或上下文容量不足时才有明确收益。
- Harness 复杂度需要随模型能力变化而调整。模型越强，部分显式 scaffold 可能变薄，但状态、工具、验证和安全执行仍需要外部系统承载。
- 文章末尾强调运行时数据底座：context、trace、tool I/O、footprint、eval 和 analysis 不应各自散落，应成为可复用的运行数据资产。

## 组件清单

文章按以下组件拆解生产级 Harness：

- 编排循环
- 工具
- 记忆
- 上下文管理
- 提示词构建
- 输出解析
- 状态管理
- 错误处理
- 护栏与安全
- 验证循环
- 子智能体编排
- 生命周期和产品化运行能力

## 对 Open Agent Harness 的启发

- 文章的组件分类适合用作协议子文档完整性检查表，但不是协议结构本身。
- 我们的总纲更强调治理对象和状态边界：Action、Command、Assignment、Event、Projection、Authority、Gate、Context Bundle、Adapter。
- 文章强调 tool call、memory、context、state、guardrails 和 verification，这些都能映射到现有子协议，但需要在子文档中继续细化。
- 文章提到的 Role-based agent 框架不应直接影响本协议。我们已经把 Role 从核心对象移除，任务选择应基于 Agent 定义、Capability、Authority、Scope 和 Runtime routing。
- 文章末尾关于运行时数据底座的观点与 `Materialized State`、`Event Log`、`Projection`、`Trace` 和 `Artifact` 的方向一致，后续需要把 trace / tool I/O / eval 数据的统一存储和导出模型讲清楚。

