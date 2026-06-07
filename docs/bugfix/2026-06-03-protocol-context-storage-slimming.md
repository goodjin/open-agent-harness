# Bug Fix: Protocol Context Storage Slimming

## 问题描述
- 日期: 2026-06-03
- 严重程度: High
- 影响范围: session list/message API, local UI sidebar, protocol runner sessions

管理 `codewave` 项目时，界面会卡住或项目会话难以显示。排查发现会话没有丢失，而是 session/part 数据中重复保存了大量内部运行状态，导致列表和消息接口响应过大。

## 根因分析
- `SessionProcessor` 在每次 `start-step` 保存 `step-start` part 时复制完整 `session.dsl_context`。
- `dsl_context.protocol.tools.prompt` 是稳定 protocol prompt，却被放在会被 checkpoint 复制的 `dsl_context` 中。
- `dsl_context.protocol.runs` 保存完整 action results。
- `dsl_context.protocol.completed_delegations` 和子 session `protocol.delegation` 保存完整 child output。
- session list/children/descendants API 返回完整 `Session.Info`，导致侧边栏也下载内部 `dsl_context`。

## 修复方案
- 将稳定 protocol prompt/catalog 移到独立 `Storage` key: `session_runtime_context/<sessionID>`。
- 新写入的 protocol run 完整结果移到 `session_protocol_run/<sessionID>/<runID>`，`dsl_context.protocol.runs` 只保留轻量 action summary 和 `result_ref`。
- 新写入的 delegation 完整输出移到 `session_delegation_result/<parentSessionID>/<childSessionID>`，`dsl_context` 只保留 summary 和 `output_ref`。
- session list/children/descendants API 返回轻量 session 信息，不带 `dsl_context`。
- 本地执行一次历史数据迁移，压缩旧 `protocol.tools`、run results 和 delegation output。

## 验证步骤
1. ✅ `bun test test/session/prompt-runner.test.ts -t "session loop stores stable protocol prompt outside dsl context"`
2. ✅ `bun test test/session/runner.test.ts -t "protocol runner recovers textual AgentProtocolOutput json before file fallback"`
3. ✅ `bun test test/session/delegation.test.ts`
4. ✅ `bun typecheck`
5. ✅ `git diff --check`

## 数据验证
- `codewave` session records: 118
- `jianmo` session records: 34
- `open-agent-harness` current directory records: 0
- historical open harness records are under `/Users/jin/github/opencode/packages/opencode`: 10
- `codewave` list API for 10 sessions reduced to about 14 KB.
- `jianmo` list API for 10 sessions reduced to about 11 KB.

## 设计建议
- Treat `dsl_context.protocol` as a lightweight runtime index.
- Store stable context and large outputs in dedicated storage keys.
- Keep list APIs free of internal runtime state by default.
