# T04 Graph Cycle Detection 测试生成

## 目的

评估针对 graph validation logic 的测试生成能力。

## 项目

使用当前 `opencode` 仓库；如果需要，沿用 T03 的实验性 Agent Protocol package。

## 准备

确保存在一个应该拒绝循环依赖的 graph validator。

如果实现还不存在，创建一个最小 fixture：

```txt
packages/agent-protocol/src/graph.ts
packages/agent-protocol/test/graph.test.ts
```

实现可能已经能拒绝简单 cycle。这个任务的目标是补充重要边界测试。

## 提交给大模型的任务内容

```text
为 Agent Protocol DSL action graph cycle detection 添加 focused tests。

覆盖：
- 直接 self-dependency
- two-node cycle
- 更长的 cycle
- 带 shared dependency 的 acyclic graph

不要在测试中复制 validator 逻辑。请从 package directory 运行 focused tests。
```

## System A：ToolCall Loop 步骤

1. 搜索 graph validator 和 tests。
2. 读取相关文件。
3. 添加测试。
4. 运行 focused tests。
5. 如果测试因错误预期失败，进行修复。

## System B：ToolCall + XML 步骤

与 System A 相同，但 search/read/test 结果返回压缩 XML observations。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "locate",
      "executor": "repo.search",
      "operation": "search",
      "query": "graph cycle depends_on validator test",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["locate"],
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
    }
  ]
}
```

## 成功判定

得分 `2`：

- 添加全部四个要求的测试用例。
- 测试调用公开 validator 行为。
- 测试没有重新实现 cycle detection 逻辑。
- Focused tests 通过。

得分 `1`：

- 添加了一些有用测试，但遗漏了某个要求的 case。

得分 `0`：

- 测试很表面、脆弱，或没有真正覆盖 cycle detection。

## 需要保存的 Artifacts

- final diff
- test output
- test file snippets
- result envelopes

## 关键指标

- success score
- test attempts
- token usage
- model turns
- irrelevant observation tokens
