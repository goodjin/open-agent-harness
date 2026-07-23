# Bug Fix: 确认面板溢出、重复确认与不可读错误

## 问题描述

- 日期：2026-07-23
- 严重程度：High
- 影响范围：会话输入区上方的 Question/Confirm 面板

确认内容较长时，面板高度可以超过视口，正文没有形成有效的内部滚动区，底部确认按钮不可见。用户第一次确认成功后，前端仍保留原确认框且恢复按钮可用，导致同一个请求再次提交；后端返回 `ConflictError` 时，前端把结构化错误直接转成字符串，最终显示 `[object Object]`。

## 根因分析

1. `DockPrompt` 的 Question 样式使用 `500dvh` 作为最大高度，无法形成符合视口的边界。
2. `SessionQuestionDock` 只等待 `question.replied` 实时事件移除请求；成功响应后没有立即更新本地 Question Store，并在 `finally` 中重新启用按钮。
3. `SessionQuestionDock` 使用 `String(err)`，没有读取 SDK 错误对象的 `data.message`。
4. 实际日志显示第一次 POST 返回 200，随后相同 request id 再次 POST 并返回 409；数据库中的 confirmation 已在第一次请求后变为 `confirmed`。

## 修复方案

- 将 Question Dock 总高度限制在视口和固定像素上限内，正文使用内部纵向滚动，Footer 始终保留。
- 确认或拒绝成功后立即从当前目录的本地 Question Store 删除该请求，并保持提交态直到组件卸载。
- 对失效的 `ConflictError` 同样移除本地旧请求，避免继续重复提交。
- 统一使用服务端错误格式化函数，并支持常见结构化错误的顶层或 `data.message` 文本。

## 验证计划

1. 长 Markdown 确认内容不会撑出视口，正文可以滚动，Footer 按钮保持可见。
2. 第一次确认成功后，本地确认面板立即消失，无法再次提交同一 request id。
3. 另一个陈旧页面提交已确认请求时，显示服务端可读错误并移除旧面板。
4. Question Dock、错误格式化单元测试通过。
5. `packages/app` 类型检查与本地 Playwright 冒烟通过。
6. 重启 4096 服务后用真实 Question API 核验。
