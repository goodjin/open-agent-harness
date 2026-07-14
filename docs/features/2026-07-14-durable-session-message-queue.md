# 持久化会话消息队列

## 用户目标

会话收到的每条可执行消息都应先持久化，再进入统一队列。进程重启后，运行时可以从持久化记录恢复未消费消息；每个 run 结束后主动消费下一条消息。前端展示持久化的排队消息并允许取消。所有“继续”入口在无法无消息恢复时，自动发送一条“继续”消息。

## 已确认范围

- 用户消息和会触发 run 的内部消息先完整持久化，再进入队列。
- `noReply` 和仅用于模型上下文的合成消息不创建独立队列任务。
- 持久化 turn 是队列事实来源，进程内 callback 只负责当前调用的结果回传。
- 同一会话串行消费，按消息创建时间和消息 ID 执行 FIFO。
- 新消息入队、当前 run 结束以及实例启动恢复都会触发队列消费。
- 只有仍处于 `queued` 的消息可以取消；已进入 `running` 的消息继续使用会话停止能力。
- 前端 Follow-up 区展示后端持久化的排队消息，不再以页面内存队列作为事实来源。
- “继续”统一使用自动模式：优先恢复已有 run，不能恢复时持久化并发送文本为“继续”的普通用户消息。
- 排队消息显示“排队中”；被认领后才显示请求已发出或正在响应。

## 不在范围内

- 不引入跨机器分布式队列或外部消息中间件。
- 不改变同一会话一次只运行一个 turn 的约束。
- 不允许通过排队取消接口终止已经运行的 turn。
- 不改变 `noReply` 和合成上下文消息的现有语义。

## 状态与流程

1. API 或内部运行时解析消息 parts。
2. 消息和 parts 完整写入持久化存储，并将 turn 置为 `queued`。
3. 入队完成后调用会话 pump；若已有消费者，当前调用只登记结果回传，不创建第二个消费者。
4. pump 从持久化消息中选择最早的 `queued` turn，并以条件更新认领为 `running`。
5. run 完成、等待、失败或退出时完成当前 turn，并在清理阶段再次调用 pump。
6. 启动恢复扫描存在 `queued` 或可恢复 `running` turn 的会话，并启动 pump。
7. 取消操作只对 `queued` turn 成功；认领和取消竞争时最多一个操作成功。

## 受影响模块

- `packages/opencode/src/session/prompt.ts`：消息入队、会话 pump、run 完成后续消费。
- `packages/opencode/src/session/turn.ts`：持久化 turn 的选择、认领和完成规则。
- `packages/opencode/src/session/index.ts`：消息与 parts 持久化及条件取消。
- `packages/opencode/src/project/bootstrap.ts`：启动时恢复持久化队列。
- `packages/opencode/src/server/routes/session.ts`：自动继续和排队消息取消接口。
- `packages/app/src/pages/session.tsx`：Follow-up 提交、持久化排队区和继续入口。
- `packages/app/src/pages/session/message-timeline.tsx`：排队展示、取消及子会话继续入口。
- `packages/app/src/pages/session/helpers.ts`：排队与已发出状态文案判断。
- 对应 SDK、i18n、后端及前端测试。

## 实施计划

1. 先增加后端回归测试，覆盖持久化 FIFO、无 callback 续消费、重启恢复、取消竞争和自动继续降级。
2. 将队列唤醒从 callback 条件中解耦，建立以持久化 turn 为输入的单会话 pump。
3. 收紧 turn 认领与取消条件，保证同一 queued turn 不会同时被运行和取消。
4. 将 tree resume 扩展为自动模式，并让所有普通“继续”入口使用该模式。
5. 将前端 Follow-up 从本地草稿队列切换到后端持久化排队消息，保留取消能力。
6. 修正 live status，使 queued 与 running 在界面上可区分。
7. 更新 `docs/harness-module/` 中的运行时和 UI 说明。

## 验证计划

- 从 `packages/opencode` 运行新增的 session turn、prompt、bootstrap 和 route 定向测试。
- 从 `packages/app` 运行排队区、继续入口和 session helper 定向测试。
- 从各包运行 `bun typecheck`。
- 从 `packages/app` 运行 `bun test:e2e:local -- app/smoke.spec.ts`。
- 检查生成 SDK 和 OpenAPI 是否需要更新；接口契约变化时重新生成并验证。

## 验收标准

- 忙碌会话连续收到三条消息时，三条均在响应 API 前持久化，并按 FIFO 依次运行。
- 删除进程内会话状态或重启实例后，持久化的 queued turn 会继续消费。
- 一个 run 结束后，即使没有对应 callback，也会主动执行下一条持久化消息。
- 取消 queued turn 后该消息不会运行或在重启后恢复；running turn 不能通过该接口取消。
- 不允许无消息恢复的会话点击“继续”后，会生成并运行内容为“继续”的用户消息，不再停留在失败提示。
- UI 的排队数量和取消操作以服务端消息为准，刷新页面后保持一致。
- queued turn 不显示为模型已经开始响应。
