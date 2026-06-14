# Bug Fix: Session Model Reverts To Deepseek

## 问题描述

- 日期: 2026-06-13
- 严重程度: High
- 影响范围: 已存在的会话、protocol 恢复、delegated child session、session tree model 展示。

用户在设置或会话中切换模型后，部分“项目完成度检查与里程碑推进”类会话仍显示或继续使用 deepseek。现场记录显示全局配置已经是 `minimax-cn-coding-plan/MiniMax-M3`，但旧 protocol child session 状态仍带有 `providerID: deepseek`。

## 根因分析

- `SessionPrompt.prompt()` 接收显式 `input.model` 后只写入 user message，没有同步到 `session.model`。
- `SessionRunner.resumable()` 恢复 protocol 时使用触发该 protocol 的旧 user message model。
- `SessionPrompt.loop()` 每次执行仍使用被选中 user turn 的 `lastUser.model` 取 Provider。对于旧的 queued/internal turn，即使界面已经更新 `session.model`，实际 LLM 请求仍可能使用历史 model。
- `Session.tree()` 在没有可靠 session model 时从 user/assistant message 统计 model，容易把历史 deepseek 重新投影成会话模型。
- 前端 local scope 把 session binding 当作整对象优先级处理；当 session 只有 agent 没有 model 时，会挡住用户保存的 model selection。
- 目标会话 `ses_15031d725ffeElvFLSbZUmD9dh` 的会话树中仍有旧 provider id `minimaxi-ultra` 和一条 deepseek user message，导致当前界面继续显示或执行错误 provider。

## 修复方案

- 显式 prompt model 热写入 `session.model`。
- protocol recovery 优先使用 `session.model`。
- prompt loop 每轮重新读取 session，并用 `session.model ?? lastUser.model` 作为执行模型、标题模型、自动 compaction 模型和 synthetic user 模型。
- session tree 只把一等 `session.model` 当作可见 session model。
- 前端按字段合并 session binding、saved selection、handoff、last-message fallback。
- 对目标会话树做一次定向数据修复：备份 `opencode-local.db` 后，将 root + child sessions 以及 user messages 中的 `minimaxi-ultra` / deepseek provider 改为当前配置 `minimax-cn-coding-plan/MiniMax-M3`。

## 验证步骤

1. 添加 regression tests 覆盖旧 message deepseek 与新 session model 的冲突。
2. 运行 focused tests。
3. 运行 typecheck 和 diff check。

## 相关测试

- `packages/opencode/test/server/session-tree.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/session/runner.test.ts`

## 现场数据修复

- 备份: `/Users/jin/.local/share/opencode/backups/opencode-local-before-session-model-provider-fix-20260614.db`
- 修复前: 目标会话树 41 个 session 为 `minimaxi-ultra/MiniMax-M3`，32 个 session 无 model；user messages 中 71 条 `minimaxi-ultra/MiniMax-M3`、1 条 `deepseek/deepseek-v4-flash`。
- 修复后: 目标会话树 75 个 session 全部为 `minimax-cn-coding-plan/MiniMax-M3`；161 条 user messages 全部为 `minimax-cn-coding-plan/MiniMax-M3`。
