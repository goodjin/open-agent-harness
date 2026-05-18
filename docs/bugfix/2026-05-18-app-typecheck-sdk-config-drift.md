# Bug Fix: App Typecheck SDK Config Drift

## 问题描述

- 日期: 2026-05-18
- 严重程度: Medium
- 影响范围: `packages/app` 全量 typecheck

`packages/app` 的 `bun typecheck` 失败，错误集中在 `status-popover.tsx` 和 `global-sdk.tsx`。

## 根因分析

- `packages/app/src/components/status-popover.tsx` 读取 `sync.data.config.plugin`，但 v2 SDK 生成的 `Config` 类型缺少 `plugin` 字段。
- `packages/app/src/context/global-sdk.tsx` 把 `signal` 和 `onSseError` 传给了 `global.event()` 的参数对象；当前 SDK 签名中第一个参数只表示 query 参数，SSE 请求选项应作为第二个参数传入。
- `onSseError` 参数没有显式类型，放错位置后无法由 SDK options 推断。

## 修复方案

- 在 `packages/opencode/src/config/config.ts` 的 `Config.Info` schema 中恢复 `plugin?: string[]`。
- 重新生成 JS SDK，使 `packages/sdk/js/src/v2/gen/types.gen.ts` 暴露 `Config.plugin`。
- 将 `eventSdk.global.event({ signal, onSseError })` 改为 `eventSdk.global.event(undefined, { signal, onSseError })`，并标注 `error: unknown`。

## 验证步骤

1. ✅ `./packages/sdk/js/script/build.ts`
2. ✅ `cd packages/app && bun typecheck`
3. ✅ `cd packages/opencode && bun typecheck`
4. ✅ `cd packages/sdk/js && bun typecheck`
5. ✅ `cd packages/app && bun test --preload ./happydom.ts ./src/components/settings-agents-helpers.test.ts ./src/i18n/parity.test.ts ./src/context/global-sync.test.ts ./src/pages/layout/helpers.test.ts`
6. ✅ `cd packages/opencode && bun test test/server/agent-manage.test.ts test/server/session-list.test.ts`
7. ✅ `git diff --check`
