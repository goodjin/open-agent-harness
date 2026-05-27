# T03 Schema Validation 边界 Bug 修复

## 目的

评估小型 coding fix 能力，使用一个已知 validation bug。

## 项目

使用当前 `opencode` 仓库。

## 准备

创建一个 fixture branch 或临时 patch，在 Agent Protocol DSL schema validator 中引入一个小边界 bug。

如果当前实现还不存在，创建一个最小实验 package，例如：

```txt
packages/agent-protocol/
  src/schema.ts
  test/schema.test.ts
```

fixture bug 示例：

- validator 接受 `id: ""` 的 action。
- validator 接受重复 action ID。
- validator 接受指向不存在 action 的 `depends_on`。

任务应包含失败测试，或包含能暴露 bug 的测试命令。

## 提交给大模型的任务内容

```text
修复 Agent Protocol DSL schema validation 的边界 bug。

validator 应该拒绝：
- 空 action id
- 重复 action id
- 指向不存在 action 的 dependencies

请检查现有实现，做最小正确改动，并从 package directory 运行 focused tests。不要从 repository root 运行测试。
```

## System A：ToolCall Loop 步骤

1. 搜索 protocol schema validator。
2. 读取实现和测试。
3. 编辑 validator。
4. 从 package directory 运行 focused tests。
5. 如有失败，检查并修复。

## System B：ToolCall + XML 步骤

与 System A 相同，但 search、read、patch、test 输出都通过 XML envelope 回传。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "inspect",
      "executor": "repo.search",
      "operation": "search",
      "query": "Agent Protocol DSL schema validator action id depends_on",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["inspect"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "patch",
      "executor": "repo.patch",
      "operation": "edit",
      "depends_on": ["read"],
      "capabilities": ["filesystem.write"],
      "result_policy": "diff_summary+refs"
    },
    {
      "id": "test",
      "executor": "repo.test",
      "operation": "run_tests",
      "depends_on": ["patch"],
      "result_policy": "failures+refs"
    }
  ],
  "permission_policy": {
    "write": "allowed_in_workspace"
  }
}
```

## 成功判定

得分 `2`：

- 修复全部三个 validation boundary。
- 如果缺少测试，则新增或更新 focused tests。
- 从正确的 package directory 运行测试。
- 没有无关重构。

得分 `1`：

- 修复一个或两个边界，或测试不完整。

得分 `0`：

- 没有修复 bug，或改变了无关行为。

## 需要保存的 Artifacts

- fixture patch
- final diff
- test output
- XML envelopes
- validation failure summary

## 关键指标

- success score
- model turns
- patch attempts
- test attempts
- replayed tokens
- artifact tokens
- recovery quality
