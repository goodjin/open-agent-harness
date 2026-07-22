# Bug Fix: 跨 Run 子会话稳定汇合与确认刷新

## 问题描述

- 日期：2026-07-22
- 严重程度：High
- 影响范围：一个父会话在同一 Task/Revision 下存在多个 Run 或多个 delegated child，且模型在子会话全部结束前请求用户确认
- 现场会话：`ses_085580713ffexAJoVcOdJcnnIW`（查询 PRD 需求并分模块核对完成度）

父会话在部分子会话仍运行时被另一个 Run 的结果或恢复路径唤醒，模型基于不完整结果生成确认。确认等待期间又有子会话返回，旧确认仍保持 pending；前端同时把确认操作锚定到较早的 user Turn，造成顶部显示“等待用户确认”但当前窗口没有确认入口。

## 现场证据

- 21:18:36 父会话发生 `waiting_user -> running` 与 `waiting_user -> waiting_child` 竞争写入。
- 21:18:38 父模型请求启动并生成 `confirm_continue_wave_dispatch`。
- 21:18:51 另一个子会话才完成并提交结果。
- 21:16 至 21:20 的 user Turn 全部带有 `metadata.internal=true`、`metadata.source=delegation`，不是用户主动发送。
- 确认 assistant 是最新消息，但其 `parentID` 指向较早的原始 user Turn；时间线只截取最新 user Turn，导致最新 assistant 和确认卡片无法进入渲染窗口。

## 修复目标

1. 当前 Task/Revision 仍有会影响父模型决策的 delegated child 时，内部结果不能提前唤醒父模型。
2. Run 继续保留独立执行和结果身份，但父会话唤醒由会话级稳定 fan-in 统一裁决。
3. 用户主动消息可以打断等待；内部 delegation 结果只能在稳定 fan-in 后汇总唤醒。
4. pending confirmation 后出现新的 canonical child result 时，旧确认失效为历史快照，不能继续授权旧方案。
5. 稳定 fan-in 后一次性向模型提交旧确认内容、期间新增结果及变化说明，由模型重新确认或结束任务。
6. 当前待确认事项固定显示在会话输入区附近，不依赖历史 Turn 是否已加载。
7. 最新时间线窗口必须包含最新消息及其必要 parent Turn，不能只按最新 user Turn 截断。

## 实现方案

### 1. 会话级 fan-in 闸口

- 在 delegation 提交/恢复路径统一检查当前 Task/Revision 绑定的所有 canonical pending assignments。
- 区分用户主动 Turn 与内部 delegation Turn；只有用户主动 Turn 可以在 live children 存在时启动父模型。
- 单个 Run 完成只持久化 Result 和更新 Run，不直接越过其他 live children 唤醒父模型。
- 没有可继续自动调度的 child，且当前相关 children 全部终态时，形成稳定 fan-in 并投递一次聚合结果。

### 2. 确认版本与失效

- 确认记录保存生成时的结果基线，至少包含时间/结果身份边界。
- 新 canonical child result 晚于确认基线时，将 pending confirmation 标记为 `superseded`。
- 用户回复确认时执行同一基线校验；过期确认不得执行旧方案。
- superseded 记录保留在历史，但不进入当前 Question 列表或 `waiting_user` 判断。

### 3. 确认刷新 Turn

- 稳定 fan-in 后生成单一内部 `confirmation_refresh` Turn。
- 内容包含原确认事项、等待期间发生的变化、新增子会话结果、可能受影响的执行范围，以及要求模型重新判断的明确指令。
- 多个 child result 合并成一次刷新，避免每个结果触发一次模型调用。

### 4. UI 当前确认入口与最新消息窗口

- 在会话区域底部固定渲染当前 Question/Permission，不依赖匹配的历史 Turn。
- 时间线中的确认卡片保留为历史定位，但同一 Question 只存在一个可操作入口。
- 初始窗口按最新消息事件计算，并补齐其 parent user Turn；不能因为 parent 较早而隐藏最新 assistant。

## 验证计划

1. 两个不同 Run 均有 live child：一个 Run 完成后父模型不启动，状态保持 `waiting_child`。
2. 所有相关 child 终态后只生成一个聚合 Turn，并只启动一次父模型。
3. 用户主动消息在等待期间仍可进入父模型，并携带当前 child 状态。
4. pending confirmation 后收到 child result：旧确认变为 superseded，旧确认回复不能执行。
5. 多条 child result 聚合成一个 confirmation refresh，模型获得旧确认与全部新增结果。
6. 当前 Question 固定可见，即使原始 parent user Turn 不在时间线窗口。
7. 最新 assistant 的 parent user Turn 较早时，最新 assistant 仍显示。
8. 完整 delegation、status、prompt、question、session timeline 测试和类型检查通过。
9. `packages/app` 本地 Playwright 冒烟通过。
10. 重启 4096 服务后核验真实会话状态、Question、queued Turn 和确认入口。

## 非目标

- 不取消 Run 的独立身份或结果历史。
- 不让 Runtime 判断业务方案是否合理；Runtime只维护执行边界和最新证据基线。
- 不自动替用户确认更新后的执行方案。
- 不删除历史确认和子会话结果。
