# Harness Platform PRD 文档集

本文档集是从零建设 Harness 系统平台的统一产品真相源。它把治理协议、产品能力、用户流程、技术方案和阶段验收放在同一个目录下维护。

本文档集描述目标系统应具备的产品和工程形态。现有 `docs/harness-protocol/` 是协议定义来源；本目录把协议定义转换为新项目的产品需求、系统边界和交付验收。

## 文档地图

| 编号 | 文档 | 作用 |
|---|---|---|
| 00 | [产品愿景与范围](00-product-vision-and-scope.md) | 定义产品目标、核心价值、范围边界、成功指标和产品原则。 |
| 01 | [用户画像与使用流程](01-users-and-usage-flows.md) | 定义目标用户、主要使用场景、端到端操作流程和用户可见状态。 |
| 02 | [协议与治理需求](02-protocol-and-governance-requirements.md) | 把 Harness 治理协议转换为系统应支持的协议对象、状态、控制流和治理规则。 |
| 03 | [功能需求](03-functional-requirements.md) | 定义产品模块、功能清单、用户故事、业务规则和验收标准。 |
| 04 | [系统架构与技术方案](04-system-architecture-and-tech-stack.md) | 定义从零实现时的推荐架构、技术栈、数据层、执行层、UI、部署形态和当前项目可借鉴部分。 |
| 05 | [里程碑与验收计划](05-roadmap-and-acceptance.md) | 定义阶段目标、MVP 范围、版本验收、风险和待讨论问题。 |

## 维护规则

- 协议对象、状态词、字段语义发生变化时，同步更新 `02-protocol-and-governance-requirements.md`。
- 产品功能、用户流程、UI 入口发生变化时，同步更新 `01-users-and-usage-flows.md` 和 `03-functional-requirements.md`。
- 技术选型、部署形态、存储模型、执行环境发生变化时，同步更新 `04-system-architecture-and-tech-stack.md`。
- 阶段范围、验收标准、延期项发生变化时，同步更新 `05-roadmap-and-acceptance.md`。
