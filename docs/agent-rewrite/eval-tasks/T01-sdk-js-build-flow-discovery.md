# T01 SDK JS 构建流程发现

## 目的

评估 information gathering 能力和 source reference 质量。这个任务测试 agent 是否能在不编辑代码的情况下，找到并解释仓库里已有的工作流。

## 项目

使用当前 `opencode` 仓库。

## 准备

从 `dev` 或当前评测分支的干净 checkout 开始。

不需要 fixture patch。

## 提交给大模型的任务内容

```text
找出这个仓库中 JavaScript SDK 是如何重新生成的。

请说明：
- 应该运行什么命令
- 主要脚本或入口文件是什么
- 生成过程可能影响哪些文件或目录
- 是否存在仓库特有的警告或约束

不要编辑文件。每个结论都要包含文件引用。
```

## 预期有用证据

agent 应该注意到 `AGENTS.md` 中写着：

```text
To regenerate the JavaScript SDK, run ./packages/sdk/js/script/build.ts.
```

它应该检查该脚本以及附近的 SDK package 文件，然后总结生成流程。

## System A：ToolCall Loop 步骤

1. 提交用户任务。
2. 让模型搜索 `sdk`、`build.ts` 和 generation 相关引用。
3. 让模型读取相关文件。
4. 让模型输出最终答案。

## System B：ToolCall + XML 步骤

1. 提交同一个用户任务。
2. 每个 search/read 结果都压缩为 XML，包含 summary、files、snippets 和 artifact refs。
3. 让模型只基于 XML observations 和明确 refs 输出最终答案。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "find",
      "executor": "repo.search",
      "operation": "search",
      "query": "SDK JavaScript generation build.ts",
      "result_policy": "summary+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["find"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "summarize",
      "executor": "runtime.summarize",
      "operation": "summarize",
      "depends_on": ["read"],
      "result_policy": "final_summary+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 找到准确的 SDK 生成命令。
- 找到 build script 路径。
- 正确说明可能受影响的 SDK 区域，并提供引用。
- 如果相关，提到仓库特有约束，例如不要从 repo root 跑测试。
- 不编辑文件。

得分 `1`：

- 找到命令，但遗漏受影响文件或引用。

得分 `0`：

- 给出泛泛答案或错误命令。

## 需要保存的 Artifacts

- search output
- 读取过的文件
- final answer
- observation envelopes

## 关键指标

- model turns
- replayed observation tokens
- 读取文件数量
- 文件引用正确性
- context pollution ratio
