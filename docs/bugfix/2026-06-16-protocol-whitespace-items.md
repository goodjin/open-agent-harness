# Bug Fix: Protocol Whitespace Items

## 问题描述

- 日期: 2026-06-16
- 严重程度: Medium
- 影响范围: Agent Protocol DSL v2 execution packages

Some model outputs placed whitespace-only string values such as `"\n"` inside the top-level `items` array. JSON parsing succeeds, but schema validation rejects the whole package because every `items[]` entry must be an action object. This prevents otherwise valid worker and verifier child sessions from starting.

## 根因分析

- 问题位置: `packages/opencode/src/protocol/schema.ts`
- 原因: The v2 schema validates `items` before any top-level whitespace-item cleanup.
- 代码流程: native `AgentProtocolOutput` arguments parse as JSON, then `AgentProtocol.parse()` calls the v2 schema. If `items` contains string entries, parsing fails before executor dispatch.

## 修复方案

- Add a narrow pre-parse cleanup for top-level `items` entries that are whitespace-only strings.
- Keep all non-empty strings and other invalid values rejected.
- Add a regression test proving valid worker/verifier items execute through schema normalization.

## 验证步骤

1. ✅ Add RED regression test.
2. ✅ Confirm it fails before implementation with `Invalid input: expected object, received string` at `items[1]`.
3. ✅ Apply the parser normalization.
4. ✅ Run focused protocol schema test and package typecheck.

## 相关测试

- `packages/opencode/test/protocol/schema.test.ts`
