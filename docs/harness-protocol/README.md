# Harness Protocol 大纲

本目录只放核心协议文档。RFC、实现计划和阶段性执行编排放在 `../harness-rfc/`，不混入协议编号。

## 阅读顺序

| 编号 | 文档 | 责任 |
|---|---|---|
| 00 | `00-harness-governance-protocol.md` | 总纲：协议目标、原则、架构、对象定义和边界。 |
| 01 | `01-agent-model-and-authoring.md` | Agent 定义、外部 Markdown instruction 兼容导入、metadata、entry、capability、permission、relationships 和 authoring contract。 |
| 02 | `02-model-runtime-protocol.md` | 模型与 Runtime 的 DSL / protocol 交互协议。 |
| 03 | `03-action-executor-contract.md` | Action、Executor、toolCall carrier、recovery normalization 和执行环境契约。 |
| 04 | `04-routing-and-delegation-policy.md` | Routing、delegation、assignment、child session trace 和 executor selection。 |
| 05 | `05-handoff-protocol.md` | Handoff 触发、self-report、source bundle、handoff writer、canonical record 和目标 Context Bundle 渲染。 |
| 06 | `06-state-event-projection-model.md` | Event source、Projection、Trace / Observability、状态映射、事务边界和 replay。 |
| 07 | `07-context-memory-visibility-policy.md` | Context Bundle、Memory Scope、visibility、privacy 和 replay policy。 |
| 08 | `08-workflow-profile-action-graph-assets.md` | Workflow Profile、Workflow asset 与统一 Action Graph 执行语义。 |
| 09 | `09-ui-console-and-agent-management.md` | UI 如何管理、观察和使用 Harness 系统。 |

## 边界

- `01` 里的 `SKILL.md` 内容只说明历史兼容和外部导入适配；Harness 核心对象仍是 Agent Template、Workflow、Capability、Contract、Handoff 和 Assignment。
- `04` 定义如何选 executor 和创建 Assignment。
- `05` 定义 Assignment 或 Agent Session 之间如何交接，不再放在 Routing 章节里。
- `06` 到 `09` 是运行状态、上下文、Workflow 和 UI 的核心协议。
- `support/` 存放研究、评测和参考材料，不作为协议编号的一部分。
