# Bug Fix: Project Session Tree Child Status Falls Back To Idle

## 问题描述
- 日期: 2026-06-29
- 严重程度: High
- 影响范围: Session timeline child delegation rows and project session tree loading

## 根因分析
- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 问题位置: `packages/app/src/context/global-sync.tsx`
- 原因: Timeline child rows only read `sync.data.session_status[item.id]` and fall back to `idle`, ignoring the status already stored in delegation timeline metadata.
- 原因: Project session loading requested the process-local `/session/status` map without a directory. The page could load sessions for one directory while status rows came from the current instance project.

## 修复方案
- Timeline child row status should prefer live status, then delegation item status, then completed/notified metadata, then `idle`.
- `/session/status` should honor a `directory` query parameter so each project loads only its own status map.
- Project session loading should call `/session/status?directory=...` while keeping the existing batched descendant tree loading path.

## 验证步骤
1. Add focused unit coverage for delegation child status fallback.
2. Add server coverage for directory-scoped session status loading.
3. Run app and opencode tests from package directories.

## 相关测试
- `packages/app/src/pages/session/session-delegations.test.ts`
- `packages/app/src/context/global-sync.test.ts`
- `packages/opencode/test/server/session-list.test.ts`
- `packages/opencode/test/session/status.test.ts`

## 设计建议
- Keep DB/canonical status, live process status, and timeline projection status separate in UI code.
- Use directory-scoped status maps for project views; use timeline projection status as a display fallback when live status is absent.
