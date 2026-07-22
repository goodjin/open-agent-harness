# Bug Fix: 确认等待期间子会话结果排队且父会话状态被覆盖

## 问题描述

- 日期：2026-07-22
- 严重程度：High
- 影响范围：存在待确认问题，同时有 delegated child 完成并向父会话提交结果的协议会话
- 现场会话：`ses_085580713ffexAJoVcOdJcnnIW`（查询 PRD 需求并分模块核对完成度）

父会话仍有待回答的协议确认，但子会话结果提交把会话状态从 `waiting_user` 覆盖为 `running`。结果消息虽然成功持久化为 queued Turn，消费循环仍在等待确认，界面最终只显示“请求在排队中”，没有展示真实阻塞原因。

## 现场证据

- `/session/status` 返回父会话 `running`。
- `/question` 仍返回待确认请求 `que_f893a2013001DG9rv9NrGuRZDK`。
- `opencode-local.db` 中存在两条 queued delegation Turn：
  - `msg_f893ab438001kEg2rrYacEZUud`
  - `msg_f893d869e0013OgqguT1xXOgHb`
- 父会话 `pending_delegations` 已为空，当前子会话均已终态，不是等待子会话造成的排队。
- 当前 Run `apr_f89393269002g4ko7sShVvMV2d` 已完成 7/8；`c12_dsl_parser` 返回 `terminal_reply`，Run 投影为 blocked。

## 根因分析

1. `QuestionService.askReply()` 创建 Deferred 并把 Session 设为 `waiting_user`，原 prompt loop 在确认结果返回前保持 busy。
2. `SessionDelegation.submit()` 在子会话结果可提交时，无条件执行 `SessionStatus.set(...running)`。
3. `SessionPrompt.prompt()` 发现 Session 已 busy，按串行规则持久化新的内部 user Turn 为 `queued`。
4. 原 loop 仍在等待确认，所以 queued Turn 不会被消费；错误的 `running` 状态又隐藏了真实的 pending confirmation。

问题属于状态优先级和唤醒条件不一致：队列准入正确，队列消费也应等待用户决定，但 delegation 提交不应覆盖更高优先级的用户等待状态。

## 修复目标

1. 子会话结果提交不得覆盖 `waiting_user`、`waiting_permission` 等人工阻塞状态。
2. 人工阻塞期间允许结果消息继续可靠入队，且界面继续展示真实阻塞原因和待处理消息数量。
3. 用户回答确认后，原 prompt loop 或恢复 loop 自动按顺序消费所有 queued Turn。
4. 服务重启后，持久化的 pending protocol confirmation 仍能把 Session 恢复为 `waiting_user`，不能显示为 stale `running`。
5. 没有人工阻塞时，delegation result 仍按现有流程唤醒父会话，不降低正常 fan-in 能力。

## 修复方案

### 1. 收敛 delegation 提交时的状态写入

- 修改 `packages/opencode/src/session/delegation.ts`。
- 提交结果前读取父会话当前状态。
- 当前状态为 `waiting_user` 或 `waiting_permission` 时保留原状态，只入队结果消息。
- 仅当没有更高优先级阻塞状态时，才把父会话切换为 `running` 并请求 loop 继续。
- 增加结构化日志，区分“立即唤醒”和“因人工阻塞而排队”。

### 2. 补充 pending confirmation 的状态恢复

- 在 Session 恢复/修复路径中检查 `dsl_context.protocol.confirmations`。
- 存在当前 `pending` confirmation 或 input 时，将 stale `running`/`completed` 纠正为 `waiting_user`。
- 不在普通 GET 接口中加入隐式副作用；恢复应发生在明确的 bootstrap、prompt repair 或状态 reconciliation 路径。

### 3. 确保确认后自动排空队列

- 复核 `Question.reply`、protocol confirmation 恢复以及 `SessionPrompt.resumeAfter()` 的衔接。
- 用户决定完成后，优先继续原 running Turn；原 Turn 结束后依次 claim queued Turn。
- 不合并或删除 delegation 结果，不允许两个 queued Turn 并行消费。

### 4. UI 状态表达

- 首选复用现有 `waiting_user` 状态和 pending question 展示。
- 若顶部队列提示覆盖人工阻塞提示，则调整优先级为：等待确认/输入 > 等待权限 > 等待子会话 > 排队 > 运行中。
- 在等待确认时可附带“另有 N 条结果待处理”，但不把主状态改为“排队中”。

### 5. 现场会话恢复

- 修复部署并重启 4096 服务后，确认该会话恢复为 `waiting_user`。
- 保留现有待确认请求和两条 queued delegation Turn。
- 不代替用户回答确认。
- 用户确认或取消后，验证两条结果按序进入模型上下文，Turn 状态从 queued 变为 running/done，父会话不再残留 stale running。

## 预计影响文件

- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/status.ts` 或现有恢复入口
- `packages/opencode/src/question/service.ts`（仅在确认恢复衔接确有缺口时修改）
- `packages/opencode/test/session/delegation.test.ts`
- `packages/opencode/test/session/prompt-runner.test.ts`
- `packages/opencode/test/session/status.test.ts`
- 会话状态/顶部提示对应的 `packages/app` 文件（仅当现有 UI 优先级不正确时修改）
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. 父会话处于 `waiting_user`，child result 提交后状态保持 `waiting_user`，结果 Turn 为 queued。
2. 连续两个 child result 在确认期间完成，两个 Turn 均持久化且顺序稳定。
3. 用户确认后，原 Turn 先闭合，两个 queued Turn 依次进入 running/done。
4. 用户取消后，确认 Turn 正常闭合，已完成 child result 仍可供模型汇总，不丢失。
5. 没有 pending question 时，child result 仍会把父会话唤醒并自动运行。
6. 重启恢复存在 pending confirmation 的会话时，状态为 `waiting_user` 而不是 `running`。
7. 当前真实会话保留一个确认和两条 queued Turn，修复后状态与 UI 展示一致。
8. 从 `packages/opencode` 运行 delegation、prompt runner、status 测试和 `bun typecheck`。
9. 如修改 `packages/app`，从该目录运行 `bun test:e2e:local -- app/smoke.spec.ts`。
10. 重启 4096 服务，验证健康接口、真实 Session 状态、Question 列表和消息队列。

## 非目标

- 不改变“一次 Session 同时只消费一个 Turn”的串行规则。
- 不自动确认或取消用户尚未回答的确认请求。
- 不删除、合并或重写已完成子会话结果。
- 不在本修复中重做整个 Task/Run/Question 协议。

## 实施结果

- `SessionDelegation.submit()` 现在先读取父会话状态；处于 `waiting_user` 或 `waiting_permission` 时通过 durable queue 保存聚合结果，保留人工等待状态，并记录 `protocol.delegation.queued` 日志。
- `SessionStatus.restore()` 现在从协议上下文识别 pending confirmation/input，在队列自动恢复前把 stale 活跃状态修复为 `waiting_user`。
- UI 原有状态优先级已经是人工等待高于 queued Turn，本次增加回归用例固定该行为，无需修改生产组件。
- 没有人工等待时仍执行原有即时 fan-in 和父会话唤醒路径。

## 自动化验证

- `packages/opencode`：delegation、status、prompt 三个完整测试文件共 110 项通过。
- `packages/opencode`：`bun typecheck` 通过。
- `packages/app`：session helper 28 项测试通过。
- `packages/app`：`bun test:e2e:local -- app/smoke.spec.ts` 通过。
