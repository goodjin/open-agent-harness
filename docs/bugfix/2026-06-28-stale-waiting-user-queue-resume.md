# Stale waiting_user Queue Resume

## Problem

会话进入 protocol confirm/input 的 `waiting_user` 后，当前 user turn 可能仍停在 `running`。用户随后输入“继续”时，前端按忙时 follow-up 规则把消息写成 `queued`，这是合理行为；问题在于前一个等待回合已经没有 live pending question 或已经完成后，prompt loop 没有把旧 turn 收口，也没有继续消费后面的 queued user turn。

## Root Cause

- `waiting_user` 是 session lifecycle 状态，不应该让对应 user turn 长期保持 `running`。
- `Question.askReply()` 的 pending entry 是进程内状态；丢失后 DB 仍可能显示 `waiting_user`，但 `/question` 已没有可答对象。
- `SessionPrompt.turn()` 会优先选择最早的 unfinished user turn。旧 turn 如果仍是 `running`，后续 queued prompt 永远不会被选中。

## Scope

- 保留忙时输入进入队列的行为。
- 在 prompt loop 启动 repair 阶段，识别“user turn 未 done，但已有同 parent 的 completed assistant”的历史残留并写成 done。
- 对带显式 turn metadata 的历史消息也执行该修复，避免 fallback 只覆盖旧格式消息。
- 不改 UI 的 busy/queue 判断，不把 `waiting_user` 简化成 idle。

## Plan

1. 新增 session prompt 单测：构造 stale running user + completed assistant + newer queued user，验证 loop 会先收口旧 turn，再处理 queued user。
2. 扩展 `SessionPrompt.repair()`：扫描消息流，把已有 completed assistant 的未完成 user turn 写成 done，outcome/reason 由 assistant error 或正常完成决定。
3. 保持现有 delegation action-result repair 逻辑不变，避免影响子任务结果回填。
4. 更新 `docs/harness-module/protocol-runtime.md`，说明显式 turn metadata 也需要 completed assistant repair。

## Verification

- 从 `packages/opencode` 跑相关 session prompt 测试。
- 从 `packages/opencode` 跑 `bun typecheck`。

## Result Notes

- `SessionPrompt.repair()` 先保留 delegation action-result 的原有收口语义，再兜底修复已经有 completed assistant 的 stale user turn。
- 新增回归测试覆盖 stale `running` user turn 后面还有 queued user turn 的场景，确保旧 turn 不会再次抢占队列。
