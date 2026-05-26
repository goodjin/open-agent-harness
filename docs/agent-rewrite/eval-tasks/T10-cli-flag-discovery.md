# T10 CLI Flag 定义与消费路径发现

## 目的

评估针对 CLI 行为路径的仓库搜索和解释能力。

## 项目

使用当前 `opencode` 仓库。

## 准备

从干净 checkout 开始。

不需要 fixture patch。

先做一次预搜索，选择一个已有 CLI flag。如果 flag 随时间变化，benchmark runner 应选择一个稳定 flag，要求至少有一个定义位置和一个消费位置。

候选搜索词：

```txt
--help
--version
--model
--config
```

## 提交给大模型的任务内容

```text
在这个仓库中选择一个已有 CLI flag，并追踪它在哪里定义、解析和消费。

请说明：
- flag 名称
- 面向用户的 help 或 command definition 在哪里
- parsing 在哪里发生
- parsed value 在哪里影响行为

不要编辑文件。每一步都要引用准确文件。
```

## System A：ToolCall Loop 步骤

1. 搜索 CLI flag definitions。
2. 选择一个稳定 flag。
3. 搜索该 flag 的 references。
4. 读取 definition、parser 和 consumption files。
5. 输出 trace summary。

## System B：ToolCall + XML 步骤

与 System A 相同，但使用 XML-reduced observations。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "flags",
      "executor": "repo.search",
      "operation": "search",
      "query": "--help --version --model --config CLI flag",
      "result_policy": "files+refs"
    },
    {
      "id": "refs",
      "executor": "repo.search",
      "operation": "search",
      "depends_on": ["flags"],
      "query": "selected flag references",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["refs"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "explain",
      "executor": "runtime.summarize",
      "operation": "summarize",
      "depends_on": ["read"],
      "result_policy": "trace+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 选择一个真实存在的 flag。
- 正确找到 definition、parse path 和 behavior consumption。
- 提供文件引用。
- 不编辑文件。

得分 `1`：

- 找到 definition 和 references，但遗漏行为影响。

得分 `0`：

- 选择不存在的 flag，或给出泛泛 CLI 解释。

## 需要保存的 Artifacts

- selected flag
- search results
- file excerpts
- final trace

## 关键指标

- model turns
- files read
- reference correctness
- replayed tokens
- context pollution ratio
