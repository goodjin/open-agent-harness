# Feature: 模型声明驱动的 Task / Run Runtime

## 用户目标

模型负责理解用户请求，并通过 Agent Protocol 明确声明创建 Task、更新 Task、Handoff 新 Task、创建执行图、等待输入或返回结果。Runtime 只解释协议并执行对应的持久化、状态迁移和调度，不再次判断用户意图，也不因历史 Run Result 的重复、差异或缺失而阻断新的合法执行图。

系统应尽可能让模型声明的合法工作得到运行。无法执行的错误应优先局部化、结构化反馈并允许模型修正，不应把单个 Run、Action 或历史结果问题升级为整个 Session 的终止条件。

## 领域边界

- **Session**：对话与任务容器；一个 Session 最多绑定一个 Task，但始终允许继续对话。
- **Task**：当前 Session 的长期目标；由模型通过 `create/self` 创建。
- **Task Revision**：Task 内容、范围、约束或验收标准的版本；由模型通过 `update/self` 创建。
- **Run**：模型提交的一张 executable action graph 的一次执行实例。没有 action graph 的协议调用不创建 Run。
- **Run Result**：Run 的不可变结束结果。现有 `session_protocol_run_outcome` 作为兼容存储保留。
- **Turn**：一条用户消息或 Runtime 内部事件的一次处理生命周期，可产生多个 assistant 尝试。
- **Handoff**：模型通过 `handoff/peer` 声明新 Task；Runtime 在平级 Session 中创建并执行它。

## 协议到 Runtime 的确定性映射

| 模型协议声明 | Runtime 行为 |
| --- | --- |
| `answer` | 回复用户；不创建 Run |
| `input` | 等待用户输入；不创建 Run |
| `confirm` | 执行模型声明的确认门；不单独创建 Run |
| `create/self` | 在当前 Session 创建 Task；忽略同包执行图，确认后由 bootstrap 要求模型生成新图 |
| `update/self` | 创建新 Revision，执行旧 Revision 停止与激活流程；新图在新 Revision 下创建 Run |
| `handoff/peer` | 创建平级 Session，并在目标 Session 创建 Task；源 Session 不执行新 Task |
| executable action graph | 在当前活动 Revision 下创建新 Run |
| previous Run result | 首次写入时保存；已有结果时幂等复用，不覆盖 |
| previous Run result + graph | 保存或复用旧结果，然后创建新 Run并执行图 |

Task Markdown、普通回复和标题本身不创建或更新 Task。只有协议中明确的 Assignment 操作触发 Task 状态变化。Runtime 不把 `retry`、`rework`、`continue` 或 `new task` 作为需要自行推断的语义；这些判断由模型通过协议操作和新图表达。

## 执行原则

### 1. 新图优先于历史结果冲突

历史 Run Result 是只读事实，不是新 Run 的执行许可。已有结果来自同一 Turn、其他 Turn、fallback 或恢复流程时，Runtime 都复用原结果。模型提交的不同总结可以记录为诊断或补充观察，但不得覆盖原结果，也不得阻断同包新图。

### 2. 持久化先于副作用

创建 Task、Revision、Run 或 Handoff 时，Runtime 先持久化领域对象和完整任务图，再执行工具或创建子会话。新对象无法可靠落库时，只暂停受影响的命令，Session 保持可继续处理。

### 3. 错误局部化

- Action 失败只影响自身及依赖它的下游；独立分支继续执行。
- Agent 或 Tool 不可用时生成该 Action 的结构化失败结果，允许模型重新路由。
- 协议格式或状态前提错误返回可修复的结构化结果，允许模型重新生成，不把 Session 标记为不可继续。
- 用户拒绝、权限等待和 Task Revision 切换只暂停对应命令或分支。

### 4. Runtime 不重写模型意图

Runtime 不把 `create/self` 自动改成 `handoff/peer`，不把普通图自动解释成 Task 更新，也不根据自然语言重新分类请求。状态不匹配时返回当前状态和允许的协议操作，由模型生成下一包。

## 本轮实现范围

1. 为 Runtime 提供规范化的 Run Result 查询，区分“未结束”“已有合法结果”“结果损坏”。
2. Runner 在处理 synthetic delegation 前识别已有 Run Result：
   - 已有合法结果时跳过重复闭包要求和重复写入；
   - create/update 准入包中的图一律忽略，bootstrap 后的新包才创建 Run并执行；
   - 不再比较 Turn、assistant message 或 summary 是否相同。
3. 保持旧 Run Result 不可覆盖；不同总结只记复用诊断。
4. previous Run Result 缺失时保留模型终态、一次修复和规范化子结果 fallback；这些流程只负责关闭旧 Run，不再成为后续新图的永久阻断条件。
5. 将 Task、Revision 和 Handoff 的路由权明确保留给模型声明；Runtime 仅执行 Assignment 操作。
6. 将可恢复的协议和领域冲突返回给模型修正，避免将 Session 留在不可继续状态。
7. 更新 default、milestone-planner、feature-planner 与公共协议提示词。
8. 更新 Runs/Task 领域文档；现有 UI 继续展示一 Task 多 Runs 和每个 Run 的独立结果。

## 兼容策略

- 保留 `session_protocol_run/*` 和 `session_protocol_run_outcome/*` 存储格式。
- 旧数据继续按 Run Result 读取，不批量重写历史文件。
- 保留 outcome 首写不可覆盖规则；新增的是 Runner 对已存在结果的复用语义。
- 保留现有 `confirm` Assignment 协议，不在本轮增加一套并行任务工具。
- Task Revision 中现有 workflow 继续作为兼容聚合视图，Run 仍以 `session_protocol_run` 为执行事实；后续可单独迁移为独立 Run 表，不在本轮进行破坏性数据迁移。

## 验证计划

1. 已有 Run Result，无论属于同一 Turn 还是其他 Turn，新合法 graph 都创建新 Run并执行。
2. 已有 Run Result，模型不再输出 terminal item，Runtime 不触发 closure retry，直接执行新 graph。
3. 已有 Run Result，模型输出不同 terminal summary，旧结果不变，新 graph 正常执行。
4. Run Result 文件损坏时记录诊断；不依赖旧 Run 的新 graph 仍可创建和执行。
5. 新 graph 显式依赖未满足的历史 Action 时，仍由依赖校验阻止对应分支。
6. `create/self + graph` 只落库 Task/Revision 空 workflow，忽略同包图；bootstrap 后的新图才创建 Run。
7. `update/self + graph` 忽略同包图，经过 Revision 停止、激活和 bootstrap 后由新模型回合创建 Run。
8. `handoff/peer` 继续在平级 Session 创建新 Task，源 Session 不执行新图。
9. `answer`、`input`、`confirm` 和 result-only 包不创建新 Run。
10. 当前真实会话 `ses_085580713ffexAJoVcOdJcnnIW` 的已存在 outcome 不再导致 `prior_run_outcome_failed`；重新提交 verifier 图时可创建子会话。
11. 从 `packages/opencode` 执行 Runner、Runs、Task、Recovery 相关测试和 `bun typecheck`。
12. 重启 4096 服务后验证健康接口、提示词和受控真实协议路径。

## 实现与验证记录

- Runtime 已增加规范化 Run Result 查询，并以 `existing`、`missing`、`unreadable` 三种状态驱动后续处理。
- 已存在或不可读的历史结果不再阻断独立新图；缺失结果且无法合成时记录 `protocol.run.outcome.deferred`，新图仍创建新 Run。
- Task 状态冲突会进行最多两次模型协议修正；Runtime 不自动改写模型声明。
- 已更新三个入口 Planner、公共协议提示词和生成清单。
- `packages/opencode` 验证通过：Runner 71 项、Runs 33 项、Task 领域测试、相关 LLM/Prompt Runner 定向测试及 `bun typecheck`。

## 预计影响模块

- `packages/opencode/src/session/runs.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/protocol/task-admission.ts`
- `packages/opencode/config/protocol/planner-protocol.md`
- default、milestone-planner、feature-planner 规则及生成文件
- `packages/opencode/test/session/runs.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`
