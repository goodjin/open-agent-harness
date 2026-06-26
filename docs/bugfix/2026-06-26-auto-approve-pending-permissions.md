# Bug Fix: Auto-approve pending permissions after bootstrap

## 问题描述
- 日期: 2026-06-26
- 严重程度: High
- 影响范围: 会话权限自动批准、delegated child session、会话区权限提示

`Protocol: e5_publish_dry_run_worker (@release-runner)` 子会话处于 `blocked_permission`。用户已开启会话区底部的自动批准权限标记，但运行端仍有 3 个 pending `bash` permission request，且会话区没有弹出授权卡。

## 根因分析
- 问题位置:
- `packages/app/src/context/permission.tsx`
- `packages/app/src/context/permission-auto-respond.ts`
- `packages/opencode/src/session/status.ts`
- 当前自动批准只覆盖实时 `permission.asked` 事件和手动开启自动批准时的即时列表扫描。
- 当页面 bootstrap 或恢复后从 `permission.list()` 拉回已有 pending request 时，权限上下文没有统一扫描这些 pending request 并补发 `permission.respond`。
- UI 的“自动批准”标记表示 auto-accept 状态，不等于运行端当前 ruleset 已经 `allow`，因此运行端仍可能先产生 permission request。
- 如果进程重启导致内存 pending permission 丢失，DB 中的 `blocked_permission` 会变成无授权对象可处理的陈旧等待。

## 修复方案
- 在权限自动响应模块中增加一个 Solid effect 辅助函数，用同一套 `autoRespondsPermission` 规则扫描当前目录 store 中已有 pending permissions。
- 在 `PermissionProvider` 初始化时启用该扫描，pending request 命中自动批准时直接 `respond once`。
- 保留实时事件自动响应路径，避免改变现有交互。
- 在 `SessionStatus.restore()` 中把重启恢复出来的 `waiting_permission` 标记为 `interrupted`，因为原 permission deferred 只存在内存中，不能从 DB 恢复。

## 验证步骤
1. ✅ 添加 failing test: bootstrap 后已有 pending permission 且目录 auto-accept 命中时应调用 respond。
2. ✅ 实现扫描逻辑。
3. ✅ `bun test --preload ./happydom.ts ./src/context/permission-auto-respond.test.ts`
4. ✅ `bun typecheck`
5. ✅ `bun test:e2e:local -- app/smoke.spec.ts`
6. ✅ `bun test test/session/status.test.ts`
7. ✅ `bun typecheck` from `packages/opencode`

## 相关测试
- `packages/app/src/context/permission-auto-respond.test.ts`

## 设计建议
- 自动批准的语义是“需要授权时自动通过”，不应长期留下 pending request。
- 授权卡只应作为未开启自动批准或自动批准不可用时的人工兜底。
