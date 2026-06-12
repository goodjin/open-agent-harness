# Bug Fix: Session agent selector binding

## 问题描述
- 日期: 2026-06-10
- 严重程度: High
- 影响范围: 会话 agent 选择器、prompt/shell/command 请求 agent 一致性

在前端已有会话中修改 agent 时，agent 下拉只更新了本地 `local.agent`，没有先调用会话 agent 更新接口。随后发出的 prompt 请求会携带新的 agent。若该 session 尚未持久绑定 agent，服务端也不会认为这是冲突，因此请求没有被拦截。

## 根因分析
- 问题位置: `packages/app/src/components/prompt-input.tsx`
- 原因: agent 选择器 `onSelect` 直接调用 `local.agent.set(name, { force: true })`，绕开了 `session.tree.update` 的确认流程。
- 问题位置: `packages/opencode/src/session/prompt.ts`
- 原因: 服务端只在普通 prompt 创建 user message 时检查绑定 agent，shell 和 command 入口仍可能使用请求里的 agent。

## 修复方案
- 已有会话中选择 agent 时，先调用 `session.tree.update` 更新绑定 agent。
- 绑定更新成功后才更新本地 `local.agent`，并强制刷新当前 session。
- 已有会话中切换 agent 时保留当前模型选择，不让 agent 默认模型覆盖用户当前模型。
- 会话树管理面板只提交用户实际改过的 agent/model，避免只改模型时顺带触发 agent 覆盖确认。
- 绑定冲突时按 409 协议二次确认后用 `confirm=true` 重试；取消或失败时不修改本地 agent。
- 服务端抽出 `bound()` guard，覆盖普通 prompt、shell、command 三条入口。

## 验证步骤
1. ✅ `cd packages/opencode && bun test test/session/prompt.test.ts -t "agent switch"`
2. ✅ `cd packages/opencode && bun typecheck`
3. ✅ `cd packages/app && bun typecheck`
4. ✅ `cd packages/app && bun test src/components/prompt-input/submit.test.ts`
5. ✅ `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
6. ✅ `git diff --check`

## 相关测试
- `packages/opencode/test/session/prompt.test.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
