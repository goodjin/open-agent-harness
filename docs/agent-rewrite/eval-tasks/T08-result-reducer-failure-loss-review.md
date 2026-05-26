# T08 Result Reducer 失败信息丢失审查

## 目的

评估 result reduction correctness 相关 code review 质量。

## 项目

使用当前 `opencode` 仓库，并准备受控 review fixture。

## 准备

创建一个让 result reducer 丢失 failure detail 的 fixture diff。

示例 bug：

- test executor failure 被总结为 `status=failed`，但遗漏 failing test names。
- error artifacts 被存储了，但没有在 XML envelope 中引用。
- reducer 在抽取 structured failure data 之前就截断 stderr。

## 提交给大模型的任务内容

```text
审查当前 diff 中的 result reduction 行为。

重点关注：
- failed actions 是否保留足够信息供模型恢复
- failing test names 或 error summaries 是否被保留
- full logs 是否存为 artifacts 并被引用
- result_policy 是否被遵守

不要编辑文件。请先返回 findings，并包含文件引用和严重程度。
```

## System A：ToolCall Loop 步骤

1. 检查 git diff。
2. 搜索 reducer、envelope、artifact 和 failure handling。
3. 读取 changed files 和 tests。
4. 输出 review findings。

## System B：ToolCall + XML 步骤

与 System A 相同，但使用 reduced XML observations。

## System C：DSL 步骤

预期 DSL 形态：

```json
{
  "graph": [
    {
      "id": "diff",
      "executor": "repo.diff",
      "operation": "diff",
      "result_policy": "changed_files+refs"
    },
    {
      "id": "reducer",
      "executor": "repo.search",
      "operation": "search",
      "query": "result reducer envelope artifact failure stderr",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["diff", "reducer"],
      "result_policy": "key_sections+refs"
    },
    {
      "id": "review",
      "executor": "runtime.review",
      "operation": "review_code",
      "depends_on": ["read"],
      "result_policy": "findings+refs"
    }
  ]
}
```

## 成功判定

得分 `2`：

- 找到 seeded failure detail loss。
- 解释为什么 recovery quality 会受损。
- 检查 artifact references。
- 指出缺失测试。

得分 `1`：

- 注意到 failure handling 风险，但没找到具体信息丢失点。

得分 `0`：

- 遗漏 reducer bug。

## 需要保存的 Artifacts

- fixture diff
- review output
- 相关 reducer 文件
- human judgment

## 关键指标

- seeded bug found
- false positives
- review usefulness
- replayed tokens
- model turns
