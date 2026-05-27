# T05 Result Envelope 缺失引用测试

## 目的

评估 result envelope 完整性相关的测试生成能力。

## 项目

使用当前 `opencode` 仓库，配合 Agent Protocol runtime package 或 fixture。

## 准备

确保存在一个 result envelope builder 或 reducer，可以生成带 `refs` 的 XML result envelope。

如果还不存在，创建最小 fixture：

```txt
packages/agent-protocol/src/envelope.ts
packages/agent-protocol/test/envelope.test.ts
```

fixture 应支持 structured result 和 artifact refs。

## 提交给大模型的任务内容

```text
为 artifact references 缺失或为空的 result envelopes 添加测试。

覆盖：
- successful action 带一个 artifact ref
- successful action 不带 artifact refs
- failed action 带一个 error artifact ref
- invalid ref object 应根据当前 schema 被拒绝或省略

使用现有 envelope builder API。除非测试暴露真实 bug，否则不要重写实现。请从 package directory 运行 focused tests。
```

## System A：ToolCall Loop 步骤

1. 搜索 envelope builder 和 tests。
2. 读取实现。
3. 添加 focused tests。
4. 运行测试。
5. 如果实现违反预期行为，做最小修复。

## System B：ToolCall + XML 步骤

与 System A 相同，但返回 XML-reduced observations。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "find",
      "executor": "repo.search",
      "operation": "search",
      "query": "result envelope refs artifact test",
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
      "id": "tests",
      "executor": "repo.patch",
      "operation": "edit",
      "depends_on": ["read"],
      "result_policy": "diff_summary+refs"
    },
    {
      "id": "run",
      "executor": "repo.test",
      "operation": "run_tests",
      "depends_on": ["tests"],
      "result_policy": "failures+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 覆盖全部四个要求的 case。
- 保持现有 API 风格。
- 只有在必要时才做最小实现修复。
- Focused tests 通过。

得分 `1`：

- 部分覆盖 refs，或只使用脆弱的 snapshot 测试。

得分 `0`：

- 没有测试 missing refs 行为。

## 需要保存的 Artifacts

- final diff
- focused test output
- envelope XML examples
- action artifacts

## 关键指标

- success score
- patch size
- test attempts
- model turns
- replayed observation tokens
