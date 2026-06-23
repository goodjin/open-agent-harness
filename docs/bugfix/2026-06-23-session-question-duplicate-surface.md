# Bug Fix: Session Question Duplicate Surface

## 问题描述

- 日期: 2026-06-23
- 严重程度: Medium
- 影响范围: session confirmation and choice prompts

Pending question and confirmation prompts could appear twice: once in the composer dock and once in the active timeline message.

## 根因分析

- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 原因: the composer dock is the stable pending-question surface, while the timeline also rendered the active pending question or its matching confirmation card. The question store was keyed by request id and did not duplicate the request; the duplication came from two UI render paths.

## 修复方案

- Add a shared visibility helper for timeline question surfaces.
- Hide active pending questions in the timeline when the composer dock already owns the actionable prompt.
- Hide timeline confirmation cards that share the active pending question key.

## 验证步骤

1. Run focused timeline matching tests.
2. Run app typecheck.
3. Run the lightweight app smoke check.

## 相关测试

- `packages/app/src/pages/session/message-timeline.test.ts`
