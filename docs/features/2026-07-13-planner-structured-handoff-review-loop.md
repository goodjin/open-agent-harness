# Planner 结构化交接与复核闭环

## 用户目标

优化 `default`、`milestone-planner` 和 `feature-planner` 的规划行为。三个 Agent 应根据任务涉及的专业领域主动调用相应辅助 Agent，生成便于下游 Agent 阅读的结构化 Markdown，并在下发前调用匹配的检查 Agent 复核和修正。

## 已确认范围

- `default` 聚焦任务理解、细节澄清、矛盾梳理、结构化需求和粗粒度路由。
- `milestone-planner` 聚焦里程碑级共享决策、Feature 边界、依赖顺序和退出条件。
- `feature-planner` 聚焦 Feature 级方案、实施任务、验证任务和交付约束。
- 三个 Agent 根据内容自主选择辅助 Agent，不使用固定调用组合。
- 只要任务涉及某个专业领域，并且该领域会影响完整性、正确性、边界、风险或验收，提示词应要求尽量调用对应辅助 Agent。
- 生成规划内容后，调用与内容及风险相匹配的检查 Agent 做独立复核；主 Agent 吸收检查结论、修正文档，必要时再次复核。
- 需求和规划交接使用结构化 Markdown，不再要求面向程序解析的 `requirements.document.v1` JSON 字段集合。
- 简单、明确、低风险的请求可以不生成独立交接文档，也可以减少辅助咨询范围；影响下游执行的规划内容仍需匹配其主要风险做独立复核。

## 交接文档结构

结构按任务层级调整，不要求固定字段。默认覆盖以下信息：

- 目标与成功状态
- 背景及已知事实
- 范围、边界与排除项
- 约束、依赖、矛盾与待确认项
- 验收与验证方式
- 下游任务或路由所需上下文

允许省略无内容的章节，也允许为具体专业领域增加必要章节。最终文档应能让下游 Agent 在不读取咨询过程日志的情况下继续工作。

## 专业协作原则

1. 当前 Agent 先识别任务涉及的专业领域。
2. 对会影响规划质量的领域，优先调用已有专业 Agent 做只读分析。
3. 并行处理互不依赖的咨询；存在真实依赖时再设置顺序。
4. 当前 Agent 汇总证据、建议、冲突和风险，形成一份连贯的结构化 Markdown。
5. 文档生成后，根据文档内容调用需求、路由、设计、测试、安全、性能、可访问性、API 合约等匹配的检查 Agent。
6. 当前 Agent 修正检查发现的漏洞、不合理项、矛盾和遗漏。修正影响重要边界时，重新调用受影响的检查 Agent。
7. 检查意见已经解决，或剩余风险已明确记录后，再把最终文档交给下游 Agent。

## 实现计划

1. 调整三个 Agent 的 identity 和 rules，明确各自规划层级、结构化 Markdown 交接和“分析—生成—复核—修正”闭环。
2. 调整三个 Agent 的 collaboration edges 和 request footer，补充按需专业咨询及独立复核倾向。
3. 为 `default` 增加需求完整性和路由合理性检查角色；复用已有设计、测试及专项风险检查角色。
4. 删除 `default` 对固定需求 JSON schema、review marker 和自动文档复审循环的提示词要求。
5. 更新 Agent loader 相关测试和生成的内置 Agent 清单。
6. 更新 `docs/harness-module/` 中对应的协议运行时说明。

## 影响模块

- `packages/opencode/config/agents/default/`
- `packages/opencode/config/agents/milestone-planner/`
- `packages/opencode/config/agents/feature-planner/`
- 新增的需求及路由检查 Agent 配置
- `packages/opencode/test/agent/`
- `packages/opencode/src/agent/builtin.generated.ts`
- `docs/harness-module/`

## 验证计划

- 重新生成内置 Agent 清单。
- 从 `packages/opencode` 运行 Agent loader 和 delegation 聚焦测试。
- 从 `packages/opencode` 运行 `bun typecheck`。
- 运行 `git diff --check`。
- 检查三个 planner 的提示词不再要求固定需求 JSON，并同时包含按需专业咨询、独立复核、修正定稿和最终交接规则。

## 非目标

- 不修改 Agent Protocol DSL 的运行时 schema。
- 不增加固定的 Agent 调用矩阵。
- 不让辅助 Agent 代替当前 planner 做最终决策。
- 不把检查报告原样拼接进最终交接文档。
