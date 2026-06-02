# 微信文章：刚刚，一篇最全 Agent Harness 综述来了

- 来源：https://mp.weixin.qq.com/s/pG39PRnZFjSIxwYcPKD47A
- 标题：刚刚，一篇最全Agent Harness综述来了！
- 公众号：Datawhale
- 抓取时间：2026-05-28
- 页面发布时间：2026-05-28
- 对应英文原文：`Agent Harness Engineering: A Survey`
- 论文主页：https://picrew.github.io/LLM-Harness/
- OpenReview：https://openreview.net/forum?id=3hXEPbG0dh

## 内容定位

这篇文章是对英文综述论文《Agent Harness Engineering: A Survey》的中文整理。文章重点不是介绍某个具体框架，而是说明 Agent Harness 已经从 prompt / context 层面的工程技巧，上升为一套独立的系统工程对象。

## 主要观点

- Agent 失败不只来自模型能力不足，很多失败来自模型外部系统：工具接口、上下文、沙箱、状态、验证、权限和恢复。
- Agent 工程经历了 Prompt Engineering、Context Engineering、Harness Engineering 三个侧重点迁移。
- Harness Engineering 解决的是“如何让模型在真实世界里可靠行动”。
- 论文提出 ETCLOVG 七层框架：Execution、Tooling、Context、Lifecycle、Observability、Verification、Governance。
- Observability 和 Governance 应作为独立层处理，因为生产 Agent 已经具备行动能力，需要知道它做了什么，也需要知道它被允许做什么。
- Agent 评估应 trace-native，不只看最终 pass rate，还要评估执行路径、成本、风险、失败归因和评估器可信度。
- 生产 Agent 的核心矛盾包括成本/质量/速度三角、能力/控制矛盾、harness coupling。
- Agent 生态正在从 framework 走向 platform，竞争点会转向 durable workspace、sandbox、identity、observability、evaluation、governance 和 human handoff。
- 好 Harness 不只是增加控制层，也需要随着模型能力提升而删除不再必要的 scaffold。

## 对 Open Agent Harness 的启发

- ETCLOVG 与我们总纲中的运行平面高度对应，但它把 Observability 和 Governance 明确提升为独立维度，值得在后续子协议中进一步展开。
- Trace-native evaluation 与我们的 Event、Projection、Artifact、Review、Verification、export 模型一致，但需要更明确地把 trace 作为评测和失败归因对象。
- Harness coupling 提醒我们：Action、Executor、Context Bundle、Gate、Projection、Memory、Adapter 之间不是孤立模块，子协议变更需要按系统行为验证。
- 从 framework 到 platform 的判断支持我们继续把 Harness 定义为可治理的 agent operating environment，而不是仅定义 workflow DSL 或 tool calling schema。

