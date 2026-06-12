# Bug Fix: Session Model Selector Binding

## 问题描述

- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: 已有会话底部 prompt 模型选择器

已有会话中从底部 prompt 区域选择模型时，UI 的 local model 可能变化，但当前会话的服务端绑定没有同步更新。若该会话已有 `session.model`，local draft 会被服务端绑定覆盖，表现为模型看起来无故变化或无法修改。

## 根因分析

- 问题位置: `packages/app/src/components/prompt-input.tsx`
- 会话树管理页修改模型会调用 `/session/tree/sessions`，服务端会写入 `Session.setModel()`。
- prompt 底部模型选择器直接传入 `local.model`，`ModelSelectorPopover` 调用的只是 `local.model.set()`。
- 对已有会话，`useLocal().scope()` 优先读取 `sync.session.get(session).model`，因此只改 local draft 不能稳定改变当前会话模型。

## 修复方案

- 为 prompt 底部模型选择器增加 session-aware model wrapper。
- 未创建会话时保持原逻辑，只更新 local draft。
- 已有会话时先调用 `session.tree2.update({ ids, model })` 写入会话绑定，成功后强制同步会话，再更新 local recent/selection。
- 请求失败时不改本地模型，并展示错误 toast。

## 验证步骤

1. 运行 `cd packages/app && bun typecheck`。
2. 运行 `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`。
3. 运行 `git diff --check`。

## 相关文件

- `packages/app/src/components/prompt-input.tsx`

