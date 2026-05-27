# Agent Protocol DSL Pilot 评测任务

这个目录定义 Agent Protocol DSL 第一批 12 个 pilot 评测任务，用来对比 Agent Protocol DSL 和 tool-call baseline。

## 项目选择

主评测项目使用当前 `opencode` 仓库。

原因：

- 它是真实的 TypeScript/Bun monorepo，不是玩具 benchmark。
- 它已经包含 Agent Protocol DSL 和 workflow runtime 相关设计文档。
- 它有真实的代码搜索、文档、schema、SDK 和测试工作流。
- 它可以在一个代码库里覆盖 coding、review、test generation、information gathering 等任务。

对于需要已知 bug 或 review 目标的任务，先创建一个临时 fixture patch，再在不同系统之间 reset 仓库状态。

## 被测系统

每个任务都用三个系统运行：

1. `toolcall`：命令式 native tool-call loop。
2. `toolcall_xml`：命令式 tool-call loop，但工具结果压缩成 XML result envelope。
3. `dsl`：Agent Protocol DSL，runtime 解析 action graph，并返回 XML result envelope。

另外需要单独记录 `dsl_text_only` 模式：

- 模型不使用 native tool calling。
- runtime 用普通文本提示模型如何输出协议。
- 模型返回一个 fenced `json agent-protocol` 代码块和可选 Markdown sections。
- runtime 从 assistant text 中解析协议、校验、执行、回传 XML result envelope。

`dsl_text_only` 不是额外协议，而是 `dsl` 的基础交互模式。`toolcall` 和 `toolcall_xml` 只适用于支持 native tool calling 的模型；如果模型没有工具调用能力，只运行 `dsl_text_only`，并记录 valid DSL rate、repair attempts、task success 和 token/latency。

所有系统必须使用：

- 同一个模型版本
- 同一个仓库状态
- 同一个最大 wall-clock budget
- 同一个成功判定 rubric
- 同一组可用能力

## 通用 Run 目录

每次运行应写入：

```txt
eval/runs/<task-id>/<system>/<run-id>/
  task.md
  prompt.txt
  trace.jsonl
  metrics.json
  final.md
  diff.patch
  judgment.json
  artifacts/
    ...
```

## 通用指标

每个任务记录这些指标：

- total input tokens
- total output tokens
- replayed observation tokens
- stored artifact tokens
- model turns
- executor actions
- invalid DSL count，仅用于 `dsl`
- repair attempts
- model latency
- runtime latency
- tool latency
- end-to-end latency
- task success score：`0`、`1` 或 `2`
- context pollution labels，人工标注时记录

## 任务索引

1. [T01 SDK JS 构建流程发现](./T01-sdk-js-build-flow-discovery.md)
2. [T02 Runtime Action 执行路径发现](./T02-runtime-action-execution-path.md)
3. [T03 Schema Validation 边界 Bug 修复](./T03-schema-validation-boundary-bug.md)
4. [T04 Graph Cycle Detection 测试生成](./T04-graph-cycle-detection-tests.md)
5. [T05 Result Envelope 缺失引用测试](./T05-result-envelope-missing-refs-tests.md)
6. [T06 Result Policy 字段重命名](./T06-result-policy-field-rename.md)
7. [T07 Permission Bypass 代码审查](./T07-permission-bypass-review.md)
8. [T08 Result Reducer 失败信息丢失审查](./T08-result-reducer-failure-loss-review.md)
9. [T09 测试失败调试](./T09-test-failure-debugging.md)
10. [T10 CLI Flag 定义与消费路径发现](./T10-cli-flag-discovery.md)
11. [T11 跨文件新增 Result Policy 选项](./T11-add-result-policy-option.md)
12. [T12 设计与实现对齐审查](./T12-design-implementation-alignment.md)

## 推荐 Pilot 规模

第一阶段 pilot：

- 每个任务每个系统跑 1 次。
- 总运行数：`12 tasks * 3 systems = 36 runs`。
- 人工检查所有 final output。
- 对 T01、T03、T07、T09、T12 做 context pollution 人工标注。

第二阶段 pilot：

- 每个任务每个系统跑 3 次。
- 总运行数：`12 tasks * 3 systems * 3 seeds = 108 runs`。
- 使用多数成功结果，并报告方差。
