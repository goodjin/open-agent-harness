# Bug Fix: Planner Agents Missing Read Tools

## 问题描述

- 日期: 2026-06-04
- 严重程度: High
- 影响范围: protocol runner planner chain

`milestone-planner`、`epic-planner`、`feature-planner` 在拆解任务时无法使用 `read`、`glob`、`grep` 等只读上下文工具。像 A.3 `runtime_process`、A.4 `event_log_projection`、A.5 `sse_recovery` 这类需要理解代码和需求背景的规划任务，会因为 planner 直接读取上下文被协议拒绝而阻塞。

## 根因分析

- 问题位置:
  - `packages/opencode/config/agents/default/meta.json`
  - `packages/opencode/config/agents/milestone-planner/meta.json`
  - `packages/opencode/config/agents/epic-planner/meta.json`
  - `packages/opencode/config/agents/feature-planner/meta.json`
- 原因:
  - planner agent 使用 `permission_mode: "custom"` 和 `inherit_permissions: false`。
  - `allowed_tools` 只有 `task`、`question`。
  - `denied_tools` 显式包含 `read`、`glob`、`grep`。
  - `RuntimeTools.build()` 根据 agent permission 过滤 catalog，导致 planner prompt 和 runtime execution 都拿不到只读工具。

## 修复方案

- 修改 planner 类 agent 的权限边界:
  - 允许 `read`、`glob`、`grep`、`codesearch`、`lsp`、`external_directory`。
  - 保留 `task`、`question`。
  - 继续禁止 `edit`、`write`、`apply_patch`、`bash`、`todowrite`。
- 同步内置 fallback default agent 配置。
- 重新生成 `packages/opencode/src/agent/builtin.generated.ts`。
- 更新测试，让 planner prompt 明确暴露 `read`、`grep`，同时不暴露 `edit`。

## 验证步骤

1. ✅ `bun script/build.ts`
2. ✅ `bun test test/agent/loader.test.ts test/agent/schema.test.ts test/session/prompt-runner.test.ts`
3. ✅ `bun typecheck`

## 相关测试

- `test/agent/loader.test.ts`
- `test/agent/schema.test.ts`
- `test/session/prompt-runner.test.ts`

## 设计建议

planner 不应该拥有写入和执行权限，但需要基础只读上下文工具。对于宽范围代码调查仍然可以委托 `explore`，但简单读文件、搜符号、确认上下文不应强制拆出额外 agent。
