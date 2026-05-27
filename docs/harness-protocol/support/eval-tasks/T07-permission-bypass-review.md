# T07 Permission Bypass 代码审查

## 目的

评估 agent 对安全敏感 protocol/runtime 变更的 code review 质量。

## 项目

使用当前 `opencode` 仓库，并准备受控 review fixture。

## 准备

创建一个引入 permission bypass 的 fixture diff。

示例 bug：

- 当 `permission_policy` 缺失时，带 `capabilities: ["filesystem.write"]` 的 action 被允许执行。
- runtime 将未知 permission mode 当作 `allow` 处理。
- executor auto-selection 可以为声明为 read-only 的 action 选择 write executor。

不要告诉模型 bug 的具体位置。

## 提交给大模型的任务内容

```text
审查当前 diff 中 Agent Protocol DSL permission handling 的实现。

重点关注：
- write 或 execute actions 是否可以绕过 approval
- unknown permission modes 是否 fail closed
- executor auto-selection 是否可能提升 capabilities
- tests 是否覆盖 denied 和 approved cases

不要编辑文件。请先返回 findings，并包含文件引用和严重程度。
```

## System A：ToolCall Loop 步骤

1. 检查 git diff。
2. 搜索 permission policy 和 executor selection。
3. 读取 changed files 和相关 tests。
4. 输出 review findings。

## System B：ToolCall + XML 步骤

与 System A 相同，但 diff/read/search 结果压缩成 XML envelopes。

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
      "id": "permission",
      "executor": "repo.search",
      "operation": "search",
      "query": "permission_policy capabilities approval executor",
      "result_policy": "files+refs"
    },
    {
      "id": "read",
      "executor": "repo.read",
      "operation": "read",
      "depends_on": ["diff", "permission"],
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

- 找到 seeded permission bypass。
- 解释影响和 exploit path。
- 引用准确文件位置。
- 指出缺失或薄弱测试。
- 没有过多 false positives。

得分 `1`：

- 标出可疑 permission logic，但没有找到精确 exploit path。

得分 `0`：

- 遗漏 permission bypass。

## 需要保存的 Artifacts

- fixture diff
- review output
- 读取过的文件
- finding labels
- human judgment

## 关键指标

- seeded bug found
- false positives
- severity accuracy
- model turns
- context pollution ratio
- user-rated usefulness
