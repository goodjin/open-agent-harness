# Bug Fix: Global RPM Limiter

## 问题描述

- 日期: 2026-06-12
- 严重程度: High
- 影响范围: 多个并行 agent session 调用同一上游 LLM provider 时，容易触发上游 `rate limit exceeded(RPM)`。

## 根因分析

- 问题位置: `packages/opencode/src/session/llm-concurrency.ts`
- 原因: 运行时只有 provider/model 并发限制。该限制约束的是同时在飞请求数，不能约束每分钟请求启动次数。
- 代码流程: `LLM.stream()` 进入 `LLMConcurrency.acquire()` 后，只检查 active count；大量短请求或错误重试可以快速释放并发槽并继续启动下一次请求，导致三个 session 也能在一分钟内打出远高于上游 RPM 的请求量。

## 修复方案

- 在 provider/model config schema 中增加 `rpm` 正整数配置。
- 在 provider merge 结果中保留 `rpm`，使 LLM 请求路径可读取配置。
- 在 `LLMConcurrency.acquire()` 中同时检查并发和滚动一分钟 RPM。
- 为 RPM 等待队列增加定时唤醒，避免没有请求释放时队列停住。
- 设置页自定义 provider 表单增加 provider RPM 和 model RPM。
- 生成 SDK v2 类型，让 `/config` 和 `/global/config` 的请求/响应类型包含 `rpm`。

## 验证步骤

1. ✅ 新增 RPM 队列单测，确认超过 RPM 后进入 `rate_limited`，窗口打开后自动继续。
2. ✅ 更新自定义 provider 表单单测，确认 provider/model RPM 写入 config payload。
3. ✅ 运行 package typecheck 和 app smoke test。

## 相关测试

- `packages/opencode/test/session/llm-concurrency.test.ts`
- `packages/app/src/components/dialog-custom-provider.test.ts`

## 设计建议

- `concurrency` 和 `rpm` 是两个不同维度：前者保护本地并发和连接数，后者保护上游按分钟计费/限流窗口。
- 多进程部署时当前实现是进程内全局限制；如果以后同一 provider 由多个 server 进程共享，需要把 RPM 计数移到共享存储。
