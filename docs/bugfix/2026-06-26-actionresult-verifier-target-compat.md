# Bug Fix: ActionResult Verifier Target Compatibility

## 问题描述
- 日期: 2026-06-26
- 严重程度: Medium
- 影响范围: delegated verifier sessions using `ActionResult`

Verifier 子会话在提交 `ActionResult` 时如果遗漏 `target_action_id`，工具 schema 会直接拒绝输入。后续提醒又可能给出 worker 形状示例，导致模型连续重试同一类错误并触发 `tool.action_result_limit`。

## 根因分析
- `ActionResult.VerifierSchema` 要求 `target_action_id`，缺失时工具调用不会进入执行逻辑。
- `SessionDelegation.remind()` 只传入 `action_id`，没有根据子会话 agent 和任务关系生成 verifier 示例。
- 部分 assignment 投影没有保存 `depends_on`，导致后续提醒/请求 footer 难以恢复 verifier 对应的 worker id。

## 修复方案
- 为 verifier 上下文增加兼容 schema：如果缺少 `target_action_id`，使用当前上下文 target 自动补齐并按 verifier result 接收。
- 修复 delegated reminder 的 `ActionResult` 示例，按子会话 agent 判断 verifier 并传入 target。
- target 推断优先使用 metadata/dependency 信息，缺失时兼容 `_test` / `_review` action id 后缀。

## 验证步骤
1. 补充单元测试覆盖缺失 `target_action_id` 的 verifier 兼容解析。
2. 补充单元测试覆盖 verifier reminder 使用 verifier 示例。
3. 运行相关测试和 typecheck。

## 相关测试
- `packages/opencode/test/session/action-result.test.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `packages/opencode/test/session/request-footer.test.ts`
