# Bug Fix: Protocol form input questions

## 问题描述
- 日期: 2026-06-10
- 严重程度: High
- 影响范围: Agent Protocol `kind: "input"` 表单交互、会话区选择框展示

模型输出 `version: "2"` 协议时，如果 `items[].kind` 为 `input` 且 `mode` 为 `form`，并把选项放在 `fields[].options` 中，会话区没有展示对应选择框。

## 根因分析
- 问题位置: `packages/opencode/src/session/runner.ts`
- 原因: protocol schema 已经保留了 `fields`，但 runtime 的 `inquire()` 只读取顶层 `input.options`，忽略了 `input.fields`。因此表单协议被转换成一个没有 options 的普通 question，前端只能显示自定义输入，不能显示每个字段的选择项。

## 修复方案
- 当 `mode === "form"` 且存在 `fields` 时，把每个 field 展开成一个 `QuestionInfo`。
- `single` field 显示单选，`multi` field 显示多选，text-like field 显示自定义输入。
- 用户回答回传给模型时包含 field id、field label、option id 和 option label，避免只拿到展示文案。

## 验证步骤
1. ✅ `cd packages/opencode && bun test test/session/runner.test.ts -t "form input fields"`
2. ✅ `cd packages/opencode && bun typecheck`
3. ✅ `cd packages/app && bun typecheck`
4. ✅ `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
5. ✅ `git diff --check`

## 相关测试
- `packages/opencode/test/session/runner.test.ts`

