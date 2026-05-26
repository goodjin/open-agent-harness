# T02 Runtime Action 执行路径发现

## 目的

评估更深层的仓库导航能力。任务要求 agent 追踪 runtime 或 workflow action 如何表示、如何执行。

## 项目

使用当前 `opencode` 仓库。

## 准备

从干净 checkout 开始。

不需要 fixture patch。

## 提交给大模型的任务内容

```text
追踪这个仓库中 workflow 或 agent runtime action execution 的当前实现路径。

请说明：
- 哪些文件定义 action 或 workflow data model
- 哪些文件负责执行或恢复 actions
- status 或 state 如何持久化
- 哪些部分看起来和未来 Agent Protocol DSL 工作相关

不要编辑文件。请引用准确文件，并按执行顺序解释路径。
```

## 预期有用证据

agent 应先检查 `docs/agent-rewrite/` 里的文档，再定位 `packages/` 下的实现文件。

具体目标文件可能随时间变化，所以成功判定重点看 trace 质量，而不是固定文件路径。

## System A：ToolCall Loop 步骤

1. 在 docs 中搜索 `workflow`、`action`、`runtime`、`resume`、`state`。
2. 在 packages 中搜索相同实现术语。
3. 读取候选文件。
4. 输出 execution path summary。

## System B：ToolCall + XML 步骤

1. 使用相同 search/read 序列。
2. 将每个结果压缩成 matched files、short snippets 和 refs。
3. 基于 XML observations 生成最终总结。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "docs",
      "executor": "repo.search",
      "operation": "search",
      "query": "workflow runtime action resume state docs/agent-rewrite",
      "result_policy": "files+refs"
    },
    {
      "id": "impl",
      "executor": "repo.search",
      "operation": "search",
      "query": "workflow action runtime resume status",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["docs", "impl"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "map",
      "executor": "runtime.summarize",
      "operation": "summarize",
      "depends_on": ["read"],
      "result_policy": "execution_path+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 按顺序给出连贯的 execution path。
- 区分设计文档和当前实现。
- 找到 persistence/state handling。
- 每个主要结论都有文件引用。
- 不编辑文件。

得分 `1`：

- 找到相关文件，但解释不完整或顺序混乱。

得分 `0`：

- 没有仓库证据，只输出泛泛架构描述。

## 需要保存的 Artifacts

- docs search results
- implementation search results
- file excerpts
- final execution path summary

## 关键指标

- model turns
- files read
- token usage
- reference precision
- context pollution ratio
