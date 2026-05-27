# T09 测试失败调试

## 目的

评估从 failing tests 中调试和恢复的能力。

## 项目

使用当前 `opencode` 仓库，并准备受控 failing test fixture。

## 准备

创建一个 fixture，让 focused test 因一个小实现 bug 失败。

推荐 fixture：

- Result envelope builder 输出 `<status>ok</status>`，而不是 `<status>success</status>`。
- 测试期待 canonical status value。

失败应能从 test output 和附近实现中定位。

## 提交给大模型的任务内容

```text
当前 focused Agent Protocol DSL tests 正在失败。

请调试失败原因，做最小实现修复，并从 package directory 重新运行 focused tests。不要从 repository root 运行测试。避免无关重构。
```

## System A：ToolCall Loop 步骤

1. 运行 focused test command。
2. 读取 failure output。
3. 搜索/读取实现。
4. patch 实现。
5. 重新运行测试。
6. 直到通过或预算耗尽。

## System B：ToolCall + XML 步骤

与 System A 相同，但 test output 压缩成 XML，包含 failures、file refs 和 artifact refs。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "test",
      "executor": "repo.test",
      "operation": "run_tests",
      "result_policy": "failures+refs"
    },
    {
      "id": "inspect",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["test"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "fix",
      "executor": "repo.patch",
      "operation": "edit",
      "depends_on": ["inspect"],
      "result_policy": "diff_summary+refs"
    },
    {
      "id": "verify",
      "executor": "repo.test",
      "operation": "run_tests",
      "depends_on": ["fix"],
      "result_policy": "failures+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 修复实现 bug。
- Focused tests 通过。
- Patch 最小。
- 不通过修改或删除测试来掩盖失败。

得分 `1`：

- 诊断正确，但 patch 不完整。

得分 `0`：

- 诊断失败，或修改测试来隐藏失败。

## 需要保存的 Artifacts

- initial failing test output
- final passing test output
- final diff
- 两次 test run 的 envelopes

## 关键指标

- recovery score
- test attempts 数量
- patch attempts 数量
- model turns
- replayed observation tokens
- latency
