# 阶段三：Harness 治理能力

## 目标

把 Harness 的治理能力引入控制台：Memory、Concept、Authority、Gate Detail 和 Impact Scan。用户不仅能看到任务状态，还能理解 Agent 为什么这样做、用了哪些记忆、触碰了哪些概念、需要哪些批准。

本阶段回答：

- Agent 使用了哪些 Project/Team/Global Memory？
- 当前有效 Concept 是什么？
- 某次代码变更是否触碰了受治理概念？
- 谁有什么 Authority？
- Gate 为什么通过或失败？

## 交付物类型

- 后端：interface
- 前端：presentation
- 集成测试：interface + presentation

## 后端工作

### T-01 实现 Memory Service 最小版

能力：

- 查询 run/project/team/global memory
- 返回 scope 和 namespace
- 标记 current/historical/superseded
- 返回 evidence refs

建议文件：

- `packages/opencode/src/harness/memory.ts`

验收：

- 查询结果不会混淆 project/team/global。
- historical 记录不能覆盖 current Projection。
- 结果包含 source/evidence。

### T-02 实现 Concept Store

字段：

- id
- kind
- scope
- namespace
- status
- source refs
- lifecycle events
- replaces/replaced_by
- impact summary

建议文件：

- `packages/opencode/src/harness/concept.ts`

验收：

- 能读取 project-local concepts。
- 能展示 active/replaced/retired。
- 能通过 source refs 打开代码/文档路径。

### T-03 实现 Concept Replacement Request

Command：

- `concept.replace.request`
- `concept.replace.approve`
- `concept.replace.reject`

Gate：

- `new_information_present`
- `source_refs_valid`
- `impact_scan_required`
- `decision_approved`

验收：

- 没有 `new_information` 的替换请求被拒绝或升级。
- 替换成功后旧 concept 标记为 replaced。
- Projection 更新 active concept。

### T-04 实现 Impact Scan

扫描：

- rg 文本引用
- 文档链接引用
- 测试文件引用
- 可选 AST/symbol 引用

产物：

- `impact-scan.json`

验收：

- 扫描结果列出 impacted files。
- stale refs 进入 follow-up task proposal。
- scan artifact 可在 UI 查看。

### T-05 Authority View 后端数据

输出：

- actor
- role
- capabilities
- authorities
- denied actions
- scope

验收：

- 每个 active assignment 能查询 authority。
- Evaluation Actor 默认无写入被审查产物权限。
- Decision Actor 不能绕过 schema gate。

### T-06 Gate Detail 数据

输出：

- gate id
- status
- required evidence
- current evidence
- blocking reason
- related artifact

验收：

- 每个 blocked task 能说明卡在哪个 gate。
- passed gate 能看到证据。

## 前端工作

### T-07 Memory 页面

Tab：

- Run Memory
- Project Memory
- Team Memory
- Global Memory

能力：

- 搜索
- 按 scope 过滤
- 查看 evidence
- 标记 current/historical/superseded

验收：

- 用户能区分不同 scope 的记忆。
- 结果显示 namespace。
- historical 记录有明显标记。

### T-08 Concept 页面

列表：

- active
- deprecated
- replaced
- retired

详情：

- status
- source refs
- replaces/replaced_by
- impact
- decisions
- evidence

验收：

- 用户能查看 Concept 当前状态。
- 用户能打开 source refs。
- replaced concept 能跳转到 current concept。

### T-09 Concept Replacement UI

能力：

- 查看 replacement request
- 查看 new information
- 查看 impact scan
- approve/reject/request more info

验收：

- 缺少 new information 时 UI 显示阻塞原因。
- 批准操作走 Command API。

### T-10 Authority 面板

位置：

- Assignment Detail
- Agent Session Detail

显示：

- capabilities
- authorities
- write scope
- denied actions

验收：

- 用户能理解某个 Actor 为什么能做或不能做某事。
- 越权失败能定位到具体 Authority。

### T-11 Gate Detail 面板

显示：

- Gate status
- required evidence
- current evidence
- blocking reason
- next action

验收：

- blocked task 的原因可见。
- 用户能从 gate 跳转到相关 artifact。

## 集成测试

### T-12 Memory Scope 测试

验收：

- project 查询不吞掉 team/global。
- team/global 记录带 namespace。
- superseded 记录不会被标记为 current。

### T-13 Concept Replacement 测试

验收：

- 缺少 new_information 的 request 被拒绝。
- 替换成功后 active Projection 更新。
- impact scan artifact 创建。

### T-14 UI 治理页面测试

验收：

- Memory 页面可按 scope 过滤。
- Concept 页面显示 source refs。
- Gate Detail 显示阻塞原因。

## 风险

- Concept 过度治理会增加维护负担；第一版只治理 API/schema/state/module boundary/decision/constraint。
- Impact Scan 初期可能不准确，必须标记 confidence。
- Team/Global Memory 可能还没有真实后端，第一版可先通过可选 provider 或 fixture 接入。

## 完成标准

- 用户能查看和理解 Memory、Concept、Gate、Authority。
- Concept 变更有明确门禁。
- Project/Team/Global Memory 不混在一起。
- Concept 治理不替代文档，只引用文档/代码/schema/test 等事实源。
