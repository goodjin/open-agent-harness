# Bug Fix: Missing Session Refresh Fallback

## 问题描述

- 日期: 2026-06-02
- 严重程度: Medium
- 影响范围: App session page refresh on a missing or deleted session URL

Refreshing a session route whose session no longer exists left the app on the stale session route and surfaced an unhandled page error from failed session/message requests.

## 根因分析

- 问题位置: `packages/app/src/pages/session.tsx`
- 原因: session route startup called `sync.session.sync(id)` without page-level rejection handling.
- 代码流程: `/session/:id` loads session info and messages. When both requests returned 404, the route stayed on the stale id and did not navigate back to a valid session page.

## 修复方案

- Added `syncCurrentSession()` wrapper for session sync calls.
- Detects 404 / not found errors.
- Shows a toast and redirects to `/:dir/session` with `replace: true`.
- Keeps non-404 errors as request failure toasts.

## 验证步骤

1. Ran app typecheck.
2. Ran focused banner helper tests.
3. Opened a deleted session URL in Playwright.
4. Confirmed the page redirected to the new session route and displayed the unavailable-session toast.

## 相关测试

- `bun typecheck` from `packages/app`
- `bun test --preload ./happydom.ts ./src/pages/session/session-insight-banner-helpers.test.ts`
