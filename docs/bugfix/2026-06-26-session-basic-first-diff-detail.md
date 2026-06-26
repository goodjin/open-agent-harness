# Bug Fix: Session Basic First Loading and Diff Detail

## 问题描述

- 日期: 2026-06-26
- 严重程度: High
- 影响范围: session 主会话区域首屏、timeline diff 摘要、Review/Logs/Protocol 右侧面板

部分会话的 user message `summary.diffs` 会保存完整 `before` / `after` 内容。打开会话时，`session.messages` 首屏响应会原样返回这些完整 diff，导致主会话区域在网络传输、JSON 解析、store 写入和 timeline 渲染上都变慢。典型样本 `Protocol: Review audit_eslint_v0_4_1 (@refactorer-verifier)` 的首条 user message 超过 800KB，其中主要来自 lockfile diff。

## 根因分析

- `session.messages` 只裁剪 message parts，没有裁剪 `message.info.summary.diffs`。
- timeline 只需要 diff 文件名和增删统计，却收到完整文件内容。
- Review 和右侧面板会随会话打开并行加载 logs、descendants、diff 等数据，和主会话首屏竞争资源。

## 修复方案

- 为 diff 增加 summary/detail 分层：
  - summary 只保留 `file`、`additions`、`deletions`、`status` 等列表展示字段。
  - detail 独立接口按 session/message/file 读取完整 `before` / `after`。
- `session.messages` 和 session diff summary 接口只返回 summary。
- timeline 的 turn diff 列表先渲染 summary，展开具体文件时再按需加载 detail。
- 打开会话时先加载并渲染主会话区域；主区 ready 后，再加载右侧已展开栏目需要的数据。

## 验证步骤

1. 运行 focused route / summary tests。
2. 运行 app timeline/review focused tests。
3. 运行 `packages/opencode` 和 `packages/app` typecheck。
4. 运行 app smoke。

## 相关测试

- `packages/opencode/test/server/session.test.ts`
- `packages/app/src/pages/session/session-delegations.test.ts`
- `packages/ui/src/components/session-turn.test.ts`

## 设计建议

首屏接口应优先返回结构化摘要。大对象内容应通过按需 detail 接口读取，避免把不一定展示的数据放进主会话渲染路径。
