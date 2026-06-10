# Bug Fix: Protocol answer extraction and prompt agent binding

## 问题描述
- 日期: 2026-06-10
- 严重程度: High
- 影响范围: Agent Protocol answer rendering, session prompt submission, session tree agent identity

部分模型输出使用 `answer` 或 `text` 字段表达最终回复，但 protocol schema 和提取逻辑只稳定读取 `message`，导致会话区没有展示这些 answer。另一个问题是已有子会话本应由绑定 agent 执行，例如 `Protocol: build_type_extensions (@build)`，但前端 prompt 请求仍可能带 composer 当前 agent `default`，导致乐观消息和请求日志显示为 `default`。

## 根因分析
- 问题位置: `packages/opencode/src/protocol/schema.ts`
- 原因: v2 `answer` item 只接受 `message`，没有兼容模型常见的 `answer` / `text` 字段别名。
- 问题位置: `packages/ui/src/components/message-part.tsx`
- 原因: 回复标题没有展示文本输出长度，不便于判断 answer 是否被提取为可见 text part。
- 问题位置: `packages/app/src/components/prompt-input/submit.ts`
- 原因: 发送 prompt、shell、command 前没有先同步 session bound agent，直接把当前 composer agent 放进请求和乐观消息。
- 问题位置: `packages/opencode/src/session/prompt.ts`
- 原因: 服务端 prompt 入口没有拒绝已绑定 session 的不同 agent 请求，API 请求仍可绕过 tree update 的确认流程。

## 修复方案
- protocol schema 兼容 `message`、`answer`、`text` 三种最终回复字段，并统一归一为 declaration message。
- 回复方框标题在“回复”后显示当前 text part 的字符数量。
- 前端发送前调用 `session.tree.update` 更新 bound agent；如服务端返回 409，则用户确认后用 `confirm=true` 重试；未确认时不发送请求。
- 服务端 prompt 入口拒绝对已绑定 session 使用不同 agent，要求先通过 session tree agent 更新接口完成确认。

## 验证步骤
1. ✅ `cd packages/app && bun test src/components/prompt-input/submit.test.ts`
2. ✅ `cd packages/opencode && bun test test/session/runner.test.ts -t "plain JSON answer"`
3. ✅ `cd packages/opencode && bun test test/session/prompt.test.ts -t "agent switch"`
4. ✅ `cd packages/opencode && bun typecheck`
5. ✅ `cd packages/app && bun typecheck`
6. ✅ `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
7. ✅ `git diff --check`

## 相关测试
- `packages/app/src/components/prompt-input/submit.test.ts`
- `packages/opencode/test/session/runner.test.ts`
