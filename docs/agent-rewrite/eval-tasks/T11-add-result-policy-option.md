# T11 跨文件新增 Result Policy 选项

## 目的

评估跨 schema、runtime、docs、tests 的 multi-file feature implementation 能力。

## 项目

使用当前 `opencode` 仓库，配合 Agent Protocol package 或 fixture。

## 准备

确保存在 result policy union 或 enum。

新增选项：

```txt
summary+errors+refs
```

预期行为：

- 返回短 summary。
- 如果存在 structured errors，则包含它们。
- 包含 artifact refs。
- 不包含完整 raw output。

## 提交给大模型的任务内容

```text
新增一个 Agent Protocol DSL result policy 选项：`summary+errors+refs`。

更新：
- schema 或 type definitions
- reducer behavior
- XML envelope output
- tests
- docs/examples

这个 policy 应包含 summaries、structured errors 和 artifact references，但不包含完整 raw output。请从 package directory 运行 focused tests。
```

## System A：ToolCall Loop 步骤

1. 搜索已有 result policy definitions。
2. 读取 schema、reducer、tests、docs。
3. patch 所有相关文件。
4. 运行 focused tests。
5. 搜索 stale 或 missing policy handling。

## System B：ToolCall + XML 步骤

与 System A 相同，但使用 XML-reduced observations。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "find",
      "executor": "repo.search",
      "operation": "search",
      "query": "result_policy summary refs errors reducer envelope",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["find"],
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
      "id": "test",
      "executor": "repo.test",
      "operation": "run_tests",
      "depends_on": ["edit"],
      "result_policy": "failures+refs"
    },
    {
      "id": "verify",
      "executor": "repo.search",
      "operation": "search",
      "depends_on": ["edit"],
      "query": "summary+errors+refs",
      "result_policy": "files+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 新 policy 被 schema 接受。
- Reducer 行为符合 specification。
- XML envelope 包含 summary、errors 和 refs。
- 完整 raw output 没有被 replay。
- tests 和 docs 已更新。

得分 `1`：

- policy 存在，但行为或 docs 不完整。

得分 `0`：

- policy 没有被正确实现。

## 需要保存的 Artifacts

- final diff
- test output
- example XML envelope
- occurrence verification

## 关键指标

- files changed
- model turns
- test attempts
- token usage
- success score
