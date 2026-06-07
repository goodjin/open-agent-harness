# T12 设计与实现对齐审查

## 目的

评估 information gathering 和 design-to-implementation alignment analysis 能力。

## 项目

使用当前 `opencode` 仓库。

## 准备

从干净 checkout 开始。

不需要 fixture patch。

使用本地设计文档：

```txt
docs/harness-protocol/02-model-runtime-protocol.md
docs/harness-protocol/support/agent-protocol-dsl-research-notes.md
docs/harness-protocol/support/agent-protocol-dsl-paper.html
```

如果已经存在 Agent Protocol runtime 实现，就进行对比。如果不存在，agent 应明确说明当前实现缺失，并列出实现要求。

## 提交给大模型的任务内容

```text
对比 Agent Protocol DSL 设计文档和当前仓库实现。

报告：
- 哪些设计要求看起来已经实现
- 哪些要求缺失
- 哪些要求存在歧义
- 哪些文件支持每个结论
- 哪个最小下一步 implementation slice 能启动 pilot evaluation

不要编辑文件。当某个要求只是文档中提到但尚未实现时，请明确说明。
```

## System A：ToolCall Loop 步骤

1. 读取设计文档。
2. 抽取 requirements。
3. 搜索 protocol/runtime components 的实现文件。
4. 读取候选文件。
5. 输出 alignment report。

## System B：ToolCall + XML 步骤

与 System A 相同，但 read/search 结果使用 XML result envelopes。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "docs",
      "executor": "repo.read",
      "operation": "read",
      "resources": [
        "docs/harness-protocol/02-model-runtime-protocol.md",
        "docs/harness-protocol/support/agent-protocol-dsl-research-notes.md",
        "docs/harness-protocol/support/agent-protocol-dsl-paper.html"
      ],
      "result_policy": "requirements+refs"
    },
    {
      "id": "impl",
      "executor": "repo.search",
      "operation": "search",
      "query": "agent protocol DSL parser validator envelope artifact result_policy permission_policy",
      "result_policy": "files+refs"
    },
    {
      "id": "read_impl",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["impl"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "compare",
      "executor": "runtime.summarize",
      "operation": "compare",
      "depends_on": ["docs", "read_impl"],
      "result_policy": "alignment_matrix+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 从文档中抽取具体 requirements。
- 正确区分 implemented、missing、ambiguous。
- 每个结论都有文件引用。
- 推荐一个能启动 pilot evaluation 的最小下一步实现 slice。
- 不虚构不存在的实现。

得分 `1`：

- 对比有用，但遗漏主要 requirements 或证据。

得分 `0`：

- 没有实现证据，只输出泛泛总结。

## 需要保存的 Artifacts

- extracted requirement list
- implementation search results
- alignment matrix
- final report

## 关键指标

- reference correctness
- missing requirement recall
- model turns
- replayed observation tokens
- context pollution ratio
