# 微信文章：大白话讲透驾驭工程六大组件

- 来源：https://mp.weixin.qq.com/s/CWneGQPz2MX7P1mD1lobgQ
- 标题：大白话讲透驾驭工程(Harness Engineering)六大组件
- 公众号：软件工程3.0时代
- 抓取时间：2026-05-27
- 页面发布时间：2026-05-25

## 内容定位

这篇文章是面向非专业或企业落地读者的 Harness Engineering 入门说明。它不强调协议、Runtime 或状态模型，而是把 Harness 拆成企业容易理解的六类组件，用来解释为什么单靠提示词不能让 AI agent 稳定干活。

## 主要观点

- AI agent 可以理解为基础模型加上 Harness。模型本身只具备生成能力，Harness 提供执行环境、工作流程、工具、检查机制和模型配置。
- Harness Engineering 的目标是把模型能力变成可复用、可管理、可规模化落地的工作系统。
- 提示词只是 Harness 中很小的一部分，不能替代工具、权限、流程、基础设施、安全和验证。
- 企业落地需要关注任务拆分、失败处理、权限控制、环境隔离、可观测性、成本控制和结果质量检查。
- Harness 可以把一套成熟能力复制到多个任务场景中，形成规模化交付能力。

## 六大组件

文章把 Harness Engineering 拆成六类组件：

- **提示词系统**：定义身份、任务、边界、示例和思考方式。
- **工具与技能**：让 AI 能访问文件、代码、网页、业务系统和组合技能。
- **捆绑基础设施**：提供工作目录、沙箱、虚拟浏览器和可观测栈。
- **编排逻辑**：管理任务拆分、执行顺序、失败处理、多 Agent 协作和模型派活。
- **钩子与中间件**：在执行前后插入检查、重试、断点续跑、压缩和质量控制。
- **模型配置**：根据任务选择模型、参数、缓存和成本策略。

## 对 Open Agent Harness 的启发

- 这篇文章的六类组件可以作为产品化落地清单，但粒度比我们的协议总纲更粗。
- “提示词系统”应在本协议中落到 Agent 模板、Model-Runtime Protocol、Context Bundle 和 Visibility Policy。
- “工具与技能”应落到 Action、Executor、Capability、Authority、Routing 和 toolCall normalization。
- “捆绑基础设施”应落到 Execution Layer、sandbox / workspace contract、Artifact、Trace 和 Materialized State。
- “编排逻辑”应落到 Runtime、Assignment、Workflow adapter、Decision、Gate 和 Projection。
- “钩子与中间件”应落到 Gate、Trigger、Verification、Review、replay / recovery 和 observation policy。
- “模型配置”应落到 Agent 模型偏好、routing policy、cost policy、runtime backend 和 model selection。

## 与本协议的差异

文章更强调“企业如何理解和落地 Harness”，适合作为沟通材料；本协议需要把这些能力进一步定义为稳定对象、状态机、权限边界和 Runtime 控制流。

对本协议最有价值的是：它把企业落地中的成本、模型选择、可观测性、沙箱、工具权限和失败处理都列入 Harness 范畴，提醒我们后续子协议不要只关注模型输出格式和 workflow DSL。

