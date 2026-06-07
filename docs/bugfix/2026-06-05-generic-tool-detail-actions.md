# Bug Fix: Generic Tool Detail Actions

## 问题描述
- 日期: 2026-06-05
- 严重程度: Medium
- 影响范围: 会话区 fallback tool 展示，尤其是 `invalid` tool result。

会话区把未注册 tool 走 `GenericTool` fallback 渲染。`invalid` 这类 tool result 只能看到单行摘要，例如 `tool=AgentProtocolOutput` 和截断后的 error，无法复制完整内容，也无法展开查看完整 input/output/metadata。

## 根因分析
- 问题位置: `packages/ui/src/components/basic-tool.tsx`
- 原因: `GenericTool` 只传入结构化 trigger，没有 children，因此 `BasicTool` 不会显示展开箭头，也没有可复制的详情文本。
- 代码流程: `message-part.tsx` 对未注册 tool 使用 `ToolRegistry.render(part().tool) ?? GenericTool`，所以 `invalid` 不会进入专用错误卡片，而是走没有详情的 fallback path。

## 修复方案
- 修改文件: `packages/ui/src/components/basic-tool.tsx`
- 修改文件: `packages/ui/src/components/basic-tool.css`
- 新增文件: `packages/ui/src/components/basic-tool-detail.ts`
- 新增文件: `packages/ui/src/components/basic-tool.test.ts`
- 修改内容:
  - 为 fallback tool 生成完整详情文本，包含非空 `input`、`output`、`metadata`。
  - 在 trigger action 区新增复制按钮，复制同一份完整详情文本。
  - 为 fallback tool 增加可展开详情区，支持长文本滚动和自动换行。

## 验证步骤
1. ✅ `cd packages/ui && bun test src/components/basic-tool.test.ts`
2. ✅ `cd packages/ui && bun typecheck`
3. ✅ Playwright 打开 `http://127.0.0.1:3001`，页面加载无 page error。

## 相关测试
- `packages/ui/src/components/basic-tool.test.ts`

## 设计建议
- 后续如果有更多 runtime/tool-call 诊断字段，可以继续放进 fallback 详情文本，保证复制内容和展开内容保持同源。
