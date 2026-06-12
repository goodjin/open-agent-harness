# Bug Fix: Strict shell command detection in chat input

## 问题描述
- 日期: 2026-06-11
- 严重程度: Medium
- 影响范围: App prompt input, automatic shell submission

聊天框在 normal mode 下会自动识别 shell 命令并走 shell submit 路径。旧逻辑只要整段文本里出现 `|`、`&&`、`>` 等 shell 操作符，就可能把自然语言误判成 shell。

## 根因分析
- 问题位置: `packages/app/src/components/prompt-input/shell-detect.ts`
- 原因: `isShellCommand()` 先用全文正则检查 shell 操作符。这个检查没有锚定开头，所以 `帮我运行 rg foo | head` 这类消息会因为中间的管道符被判定为 shell。
- 影响路径: `packages/app/src/components/prompt-input.tsx` 用该函数展示自动 shell 状态，`packages/app/src/components/prompt-input/submit.ts` 用该函数决定是否调用 `client.session.shell()`。

## 修复方案
- 删除全文 shell 操作符匹配。
- 保留开头环境变量赋值检测。
- 仅当 trim 后的第一段 token 是已知 shell 命令时才自动识别。
- 增加自然语言包含 shell 片段的回归测试。

## 验证步骤
1. ✅ `cd packages/app && bun test src/components/prompt-input/shell-detect.test.ts`
2. ✅ `cd packages/app && bun typecheck`
3. ✅ `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`

## 相关测试
- `packages/app/src/components/prompt-input/shell-detect.test.ts`
