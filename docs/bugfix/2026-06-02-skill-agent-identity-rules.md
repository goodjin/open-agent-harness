# Bug Fix: Skill Agent Identity And Rules Duplication

## 问题描述

- 日期: 2026-06-02
- 严重程度: Medium
- 影响范围: legacy `SKILL.md` 转换出的 virtual agent

没有 `## Role` / `## Workflow` / `## Rules` 分节的 skill 转成 agent 后，`identity` 和 `rules` 都会显示同一段 skill 正文。

## 根因分析

- 问题位置: `packages/opencode/src/agent/loader.ts`
- 原因: `loadSkills()` 在缺少 `## Role` 时把完整 skill 正文作为 `identity`，同时在缺少 `## Workflow` / `## Rules` 时又把完整正文作为 `rules`。

## 修复方案

- `identity`: 优先使用 `## Role`，缺失时使用简短的生成身份说明。
- `rules`: 继续优先使用 `## Workflow` 和 `## Rules`，缺失时保留完整 skill 正文，避免丢失旧 skill 内容。
- 添加回归测试覆盖无分节 Claude skill。

## 验证步骤

1. ✅ `cd packages/opencode && bun test test/agent/loader.test.ts`
2. ✅ `cd packages/opencode && bun typecheck`

## 相关测试

- `packages/opencode/test/agent/loader.test.ts`
