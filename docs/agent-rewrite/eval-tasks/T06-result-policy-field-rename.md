# T06 Result Policy 字段重命名

## 目的

评估跨 schema、runtime、tests、docs 的 multi-file edit 能力。

## 项目

使用当前 `opencode` 仓库，配合 Agent Protocol package 或 fixture。

## 准备

确保至少有三个位置使用 result policy 字段。

推荐 fixture 字段：

```json
{
  "return_to_model": "summary"
}
```

将其重命名为：

```json
{
  "model_return": "summary"
}
```

这是一个受控 multi-file change。只有当任务明确要求保留向后兼容时，旧字段才可以继续支持。

## 提交给大模型的任务内容

```text
将 Agent Protocol DSL result policy 字段从 `return_to_model` 重命名为 `model_return`。

更新：
- schema 或 type definitions
- parser/validator usage
- envelope 或 reducer usage
- tests
- docs/examples

除非已有 compatibility layer 明确需要，否则不要保留旧名称。请从 package directory 运行 focused tests，并报告 changed files。
```

## System A：ToolCall Loop 步骤

1. 搜索 `return_to_model`。
2. 读取 schema、runtime、tests、docs。
3. patch 所有相关文件。
4. 运行 focused tests。
5. 再次搜索，确认没有非预期旧字段残留。

## System B：ToolCall + XML 步骤

与 System A 相同，但 search/read/test 结果使用 XML summary。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "occurrences",
      "executor": "repo.search",
      "operation": "search",
      "query": "return_to_model",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["occurrences"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "edit",
      "executor": "repo.patch",
      "operation": "edit",
      "depends_on": ["read"],
      "result_policy": "diff_summary+refs"
    },
    {
      "id": "verify_search",
      "executor": "repo.search",
      "operation": "search",
      "depends_on": ["edit"],
      "query": "return_to_model",
      "result_policy": "files+refs"
    },
    {
      "id": "test",
      "executor": "repo.test",
      "operation": "run_tests",
      "depends_on": ["edit"],
      "result_policy": "failures+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 更新所有目标 code、tests、docs。
- 除显式 documented compatibility 外，没有旧字段残留。
- Focused tests 通过。
- 报告 changed files。

得分 `1`：

- 代码能工作，但 docs 或 examples 仍然过时。

得分 `0`：

- 部分 rename 导致 schema 或 runtime 行为损坏。

## 需要保存的 Artifacts

- initial occurrence list
- final occurrence list
- final diff
- test output
- result envelopes

## 关键指标

- files changed
- stale occurrences
- model turns
- token usage
- success score
