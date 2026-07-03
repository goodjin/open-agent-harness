# Bug Fix: Delegated Session Result Closure

## 问题描述

- 日期: 2026-07-03
- 严重程度: High
- 影响范围: delegated child fan-in, protocol planner child sessions, parent pending state, session tree UI

`Protocol: M2_routes_migration (@feature-planner)` 已经进入 `terminal_success`, 其内部 delegated children 也都结束, 但父会话 `milestone-planner` 的 `dsl_context.protocol.pending_delegations` 仍残留 M2 child id。界面因此继续展示等待子会话。

## 根因分析

- 问题位置: `packages/opencode/src/session/delegation.ts`
- delegated child 的终态没有和 parent handoff result 强绑定。
- `ActionResult` child 缺工具结果时已有 reminder 路径, 但 `AgentProtocolOutput` child 缺最终工具结果时, 普通文本结束没有稳定包装成父级 result。
- child 自身可以进入 terminal 状态, 但父级没有收到 canonical `session_result`, 所以 pending 不会清理。

## 结果闭环合同

1. delegated child 结束后必须产出一个 result。
2. 优先取 native tool result: `ActionResult` / `AgentProtocolOutput`。
3. 没有工具结果但有最后 assistant 文本时, 包装为 `plain_text_result` 并写入 `session_result`。
4. 没有文本或异常结束时, 后续应自动追加一轮 summary 生成结果; summary 也失败时生成明确 failed/blocked synthetic result, 不能留下 pending。
5. verifier 只处理成功候选结果。失败、blocked、reply、error 直接返回父会话, 由父会话裁决。
6. verifier/dependent child 返回后, 当前会话应记录“结果已处理”, 做最终归并后只向父级交付最终结果, 不能再次进入 verifier 路由造成循环。
7. dependent 会话必须来自父任务图, 并作为当前 child 的 sibling 生成, 不能由 child 临时发明嵌套任务。

## 修复方案

- 让 delegated protocol child 在无 native protocol result 但有最后文本时, 生成 `plain_text_result`。
- 保持 `ActionResult` worker 的缺工具 reminder 行为, 避免把未按合同提交的普通 worker 文本误当成功结果。
- 确保非 satisfying result 不启动 dependent sibling, 而是 fan-in 到父会话。
- 补充回归测试覆盖 protocol child plain text handoff。

## 验证计划

从 `packages/opencode` 运行:

- `bun test test/session/delegation.test.ts`
- `bun typecheck`

## 验证结果

- `bun test test/session/delegation.test.ts` -> 35 pass
- `bun typecheck` -> pass

## 运行数据修复

- 清理 `/Users/jin/.open-agent-harness/data/opencode-local.db` 中 `ses_0dd9c93cfffebENgRwxbiwi0g2` 对已终态 M2 child `ses_0dd7b45aeffe2KpMsxszpsoDeq` 的 stale `pending_delegations` 投影。
- 清理后父会话 `pending_delegations` 为 `{}`。
