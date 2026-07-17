# Bug Fix: Planner assignment examples and validation errors

## 问题描述

- 日期：2026-07-17
- 严重程度：Important
- 影响范围：default、milestone-planner、feature-planner 的最终协议提示，以及 v2 assignment 校验反馈。

三个 planner footer 中的 assignment 示例经过 `meta.json` 加载后，`plan` 内的换行会成为 JSON 字符串中的真实换行，模型看到的示例无法被 `JSON.parse`。同时，非法 assignment 组合都返回 handoff 错误，create/update 使用 peer 时缺少准确提示。

## 根因分析

- `packages/opencode/config/agents/*/meta.json` 使用单层 `\n` 编码 Markdown 换行，JSON 文件加载后转成真实换行，破坏嵌套示例 JSON。
- `packages/opencode/src/protocol/schema.ts` 用一个异或判断覆盖全部非法组合，只提供一条 handoff 错误消息。

## 修复方案

1. 在最终 compose 路径读取 `Agent.get()` 的三个 planner，逐个解析带标记的 fenced JSON 示例，并同时校验 Zod 输入协议与公开 OutputSchema 的合法组合。
2. 让 footer 中嵌套 JSON 的 Markdown 换行在最终 prompt 保持 `\\n` 字面转义。
3. 区分 handoff 缺少 peer 与 create/update 错用 peer 的校验消息。
4. 文档一致性测试只绑定稳定 assignment contract，不绑定阶段性 Runtime 英文措辞。

## 验证计划

- RED：最终 prompt 示例解析测试和非法组合错误消息测试应先失败。
- GREEN：重新生成 built-in agents，运行 schema、loader、prompt compose 定向测试。
- 运行 `bun typecheck` 和 `git diff --check`。
