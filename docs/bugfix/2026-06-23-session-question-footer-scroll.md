# Bug Fix: Session Question Footer Scroll Isolation

## 问题描述

- 日期: 2026-06-23
- 严重程度: Medium
- 影响范围: session confirmation and choice prompts

Session confirmation and choice prompts could still push the confirm button row downward after the user selected an option. Selected-option notes, custom-answer input, or expanded descriptions increased content height and made the footer harder to reach.

## 根因分析

- 问题位置: `packages/ui/src/components/message-part.css`
- 原因: the question dock footer had a fixed height but the dock root was measured from the current visible session area and the option list could become a separate scroll surface. This made the prompt too short, split the question description from the choices, and let the wide internal scroll area capture wheel events.

## 修复方案

- Remove the current-visible-area height measurement and use five viewport heights as the hard upper bound.
- Keep the question footer as a fixed 56px bottom area.
- Keep question text, hints, and options in one shared scrollable content box.
- Limit the question dock width so it does not span the whole session area.

## 验证步骤

1. Run the focused question dock unit test.
2. Run app typecheck.
3. Run the lightweight app smoke check.

## 相关测试

- `packages/app/src/pages/session/composer/session-question-dock.test.ts`
