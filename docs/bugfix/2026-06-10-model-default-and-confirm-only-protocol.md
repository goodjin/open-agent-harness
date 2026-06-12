# Bug Fix: Default model drift and confirm-only protocol packages

## 问题描述
- 日期: 2026-06-10
- 严重程度: High
- 影响范围: session model selection, protocol runner confirmation flow

## 根因分析
- 默认模型来源: `opencode.jsonc` 和 `/Users/jin/.config/opencode/opencode.json` 都把 `model` 与 `small_model` 配成了 `deepseek/deepseek-v4-flash`，前端按配置优先级展示该模型。
- 协议停住: 模型输出只有 `confirm` item 时，确认后没有任何同包下游 `tool` 或 `agent` item 可执行，runtime 会完成确认项后结束。
- 附件协议包问题: `verify_m2_e6_f5_v4_evidence` 依赖了不在当前包内的 `run_m2_e6_f5_v4_evidence`。该 id 如果是历史子会话 action_id，应允许 verifier 读取历史 worker summary；如果历史中也不存在，才应拒绝并要求模型重生。

## 修复方案
- 将仓库与用户级默认模型恢复为 `minimax-cn-coding-plan/MiniMax-M3`。
- 在 protocol 预检中新增 confirm gate 结构校验：`confirm` 必须有同包下游 action 依赖它。
- 对 confirm-only 坏包触发一次模型重生提示，不进入用户确认流程，避免确认后静默停住。
- 将 dependency 校验从 schema 层移到 runtime 层：depends id 不在当前包时，检查当前会话历史 `completed_delegations.action_id`；存在则允许，verifier handoff 复用历史 child session 的 summary/output。

## 验证步骤
1. 运行 targeted runner 测试，覆盖 confirm-only retry、verifier dependency retry、历史子会话 verifier dependency。
2. 运行 `bun typecheck`。
3. 检查默认模型配置不再指向 v4 flash。
