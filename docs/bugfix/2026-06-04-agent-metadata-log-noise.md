# Bug Fix: Agent Metadata Success Log Noise

## 问题描述

- 日期: 2026-06-04
- 严重程度: Low
- 影响范围: Session logs panel default timeline

ActGraph 主会话的日志面板会显示大量 `Agent Metadata Output_validated` 记录。后端将成功和失败的 agent metadata output validation 都写入 `SessionLog`，但前端默认日志视图没有把成功校验归入 protocol 生命周期噪音，导致成功校验逐条占据主时间线。

## 根因分析

- 问题位置: `packages/app/src/pages/session/session-log-timeline.tsx`
- 原因: `protocol()` 和 `noisy()` 只识别 `protocol.*` 与 `data.protocol === true`，未覆盖 `agent.metadata.output_validated`。
- 代码流程: `SessionLog` 写入 `agent.metadata.output_validated` 后，默认 `groupLogs()` 未过滤该类型，于是 UI 直接显示 fallback 标题 `Agent Metadata Output Validated`。

## 修复方案

- 修改文件: `packages/app/src/pages/session/session-log-timeline.tsx`
- 修改内容:
  - 将 `agent.metadata.*` 归入 Protocol 过滤视图。
  - 默认隐藏 `agent.metadata.output_validated`。
  - 保留 `agent.metadata.output_validation_failed` 在默认视图中显示。

## 验证步骤

1. ✅ 更新日志分组单测覆盖成功校验默认隐藏。
2. ✅ 更新日志分组单测覆盖失败校验默认显示。
3. ✅ 在 `packages/app` 运行相关单测。
4. ✅ 在 `packages/app` 运行类型检查。

## 相关测试

- `bun test --preload ./happydom.ts ./src/pages/session/session-log-timeline.test.ts`
- `bun typecheck`

## 设计建议

成功类 runtime 审计事件适合保留在后端日志和 Protocol 细节视图；默认时间线应优先展示用户需要处理的异常、阻塞、失败和关键动作。
