# 阶段四：可视化增强与审计

## 目标

在 Runtime 和治理数据稳定后，增强可视化和审计能力。让用户能看见任务图、概念图、事件链、Projection 来源，并支持调试、回放和导出。

本阶段回答：

- Run 的任务依赖如何可视化？
- Concept 之间如何关联？
- 某个状态是由哪些 Event 推导出来的？
- 如何回放或重建 Projection？
- 如何导出审计报告？

## 交付物类型

- 后端：interface
- 前端：presentation
- 集成测试：interface + presentation

## 后端工作

### T-01 Task Graph API

输出：

- nodes
- edges
- status
- gate summary
- artifact count
- assignment summary

接口：

```txt
GET /harness/runs/:id/graph
```

验收：

- DAG 节点和边稳定。
- loop/rework 关系可表达。
- 节点状态来自 Projection。

### T-02 Concept Graph API

输出：

- concept nodes
- relation edges
- status
- source refs
- impact summary

接口：

```txt
GET /harness/concepts/graph
GET /harness/concepts/:id/graph
```

验收：

- active/replaced/retired 可区分。
- replacement chain 可遍历。
- impact edge 可追踪到文件/模块。

### T-03 Event Explorer API

能力：

- 按 run/task/actor/concept/type 过滤
- 分页
- 查看 command -> event -> projection chain

接口：

```txt
GET /harness/events
GET /harness/events/:id
GET /harness/events/:id/chain
```

验收：

- 大 event log 可分页。
- 单个 event 能看到前后关联。

### T-04 Projection Rebuild 调试入口

能力：

- dry-run rebuild
- diff current projection
- rebuild selected run projection

验收：

- 默认只允许开发/调试模式。
- rebuild 不影响 Event Log。
- diff 可读。

### T-05 Audit Export

导出内容：

- run summary
- decisions
- approvals
- failed/passed gates
- artifacts
- event summary

格式：

- JSON
- Markdown

验收：

- 导出报告可追溯关键决策和证据。

## 前端工作

### T-06 Task Graph 视图

能力：

- DAG 可视化
- 节点状态颜色
- 点击节点打开详情
- 显示 blocked/reviewing/verifying

验收：

- 用户能看懂任务依赖和当前阻塞点。
- 图为空或节点很多时有可用降级视图。

### T-07 Concept Graph 视图

能力：

- 显示 concept relation
- replacement chain
- impacted modules/files
- source refs

验收：

- 用户能从 concept 跳到 source。
- replaced concept 能跳到 active replacement。
- 复杂图可过滤。

### T-08 Event Explorer

能力：

- 过滤
- 搜索
- 查看 payload
- 查看 chain

验收：

- 用户能定位某个状态变化来源。
- 默认展示摘要，不把 payload 噪音铺满。

### T-09 Run Comparison

能力：

- 比较两个 run 的 task/result/decision/artifact
- 比较同一任务多次 attempt

验收：

- 用户能看出 retry 前后差异。
- 用户能比较两个方案 run 的产物。

### T-10 Audit Export UI

能力：

- 选择导出范围
- 预览
- 下载/保存报告

验收：

- 导出内容包含关键证据。
- 报告能被人类审查。

## 集成测试

### T-11 Graph API 测试

验收：

- task graph 节点边正确。
- concept graph replacement chain 正确。

### T-12 Event Chain 测试

验收：

- command -> event -> projection chain 可查询。
- pagination 稳定。

### T-13 可视化页面测试

验收：

- Task Graph 页面渲染。
- 点击节点打开详情。
- Event Explorer 过滤可用。

### T-14 Audit Export 测试

验收：

- Markdown/JSON 导出包含 run、decision、gate、artifact。
- 导出不包含未授权内容。

## 风险

- 图形化容易过早复杂化；必须保留列表降级视图。
- Event Explorer 容易变成噪音入口；默认应展示摘要。
- Projection Rebuild 是危险操作，必须限制权限和环境。

## 完成标准

- 用户能通过图理解任务和概念关系。
- 用户能追溯状态来源。
- 用户能导出审计报告。
- 可视化增强不影响前面阶段的基础操作。
