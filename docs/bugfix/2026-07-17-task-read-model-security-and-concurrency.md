# Task Read Model Security And Concurrency Fixes

## 问题描述

- 日期：2026-07-17
- 严重程度：Critical / High
- 影响范围：Task canonical result、`.harness` Task 文档投影、Revision manifest、跨进程 draft 创建

Task 读取与文档投影存在四组边界问题：delegated result 未完整验证 canonical ActionResult；文档发布在目录校验后仍可能遭遇 symlink 替换；旧 Revision 的异步投影可能覆盖新 manifest；跨进程 draft 测试缺少确定性起跑屏障，并可能暴露 SQLite transient busy。

## 根因与验证路径

1. `SessionRuns` 从 `SessionResult` 读取 `raw.input.result`，没有复用 `ActionResult.stored()` 校验完整结构与 `action_id`。
2. `TaskDocuments.publish()` 即使在 rename 前再次校验 realpath 和 inode，最后的 `renameSync(tmp, file)` 仍会重新解析完整路径。攻击者可以在最后一次校验后替换父目录，并在替换目录中放入同名 temp，使发布落到项目外。manifest lock 的 `mkdirSync`、`renameSync` 和递归 `rmSync` 也有相同问题。
3. manifest 内容来自 effect 入参，没有在发布锁内重新读取当前 DB Revision。
4. 跨进程测试由进程启动时序碰运气，无法区分版本竞争、数据库迁移启动和 transient busy。

每项修复先增加真实行为测试并观察失败，再实施最小修复。安全测试使用真实目录、symlink 和跨进程 barrier，不以 mock 代替文件系统或 SQLite 行为。

## 修复方案

- delegated result 通过 canonical ActionResult schema 解析，并验证 stored `action_id` 与 SessionResult identity 一致；fallback 使用严格 Zod 边界。
- `task-fs.ts` 隔离 POSIX native 边界。它只用绝对路径打开一次项目根目录，随后逐层执行 `mkdirat` 和 `openat(O_DIRECTORY | O_NOFOLLOW)`；temp 创建、最终 rename 和失败清理分别使用同一父目录 fd 上的 `openat`、`renameat` 和 `unlinkat`。父目录路径被替换后，系统调用仍指向已打开的目录对象。
- Task manifest lock 相对已打开的 `tasks` fd 创建和删除。锁内读取 DB 当前 Revision 后生成 manifest，旧 effect 只发布自己的 immutable revision 文档。非空 stale lock 返回 `ENOTEMPTY` 时保留目录并在有界等待后失败，不再递归删除内容。
- 跨进程 draft 测试增加 barrier；若证据确认是 `SQLITE_BUSY/LOCKED`，只对该错误做有界重试，唯一性冲突仍由事务约束处理。

## 验证计划

1. canonical ActionResult 与 malformed fallback RED/GREEN。
2. 在最终 rename 前替换父目录，并放入同名攻击者 temp；项目外文件保持不变，可信 temp 只在已打开目录内 rename。
3. 反转旧、新 Revision effect 顺序，manifest 始终指向 DB 当前 Revision。
4. barrier 驱动的跨进程 draft 测试区分 transient busy 与版本唯一性。
5. `task.test.ts` 与 `runs.test.ts` 连续至少三轮通过。
6. `bun typecheck` 与 `git diff --check` 通过。

## 设计约束

- 保持 `SessionRuns.get/list` 的兼容行为。
- 保持 Task persisted result 不读取 transcript。
- 数据库正文与 current Revision 指针仍是权威记录；文档投影只能从 DB 重建，不能反写。
- `bun:ffi` backend 只在 Darwin 或 Linux 成功加载当前 libc 时启用。Linux 先从 `/proc/self/maps` 查找进程实际加载的 glibc 或 musl，再尝试标准 glibc 名称。Windows、静态 musl 或符号加载失败时不使用 path API 回退，投影返回 `false`，Task DB 提交与读取保持可用。
- [Bun FFI 文档](https://bun.sh/docs/runtime/ffi)仍将 `bun:ffi` 标为 experimental，并建议生产 native 集成优先使用 Node-API。当前实现把 FFI 封装在一个内部文件并为加载失败提供安全降级；若以后要求 Windows 也具备文档投影，需引入经过发行矩阵验证的 Node-API/native helper，而不是手写 `NtCreateFile` 结构体绑定。

## 验证结果

- canonical ActionResult 缺字段、raw action id 不一致和非 canonical fallback 均被拒绝；合法结果保持可读。
- 在最后一次校验后替换 revision 父目录并投放同名 temp，旧实现把攻击者 temp rename 成项目外 `task.md`；dirfd 实现保留攻击者文件，只在已打开目录内完成可信 rename。
- 在 manifest lock 获取前替换 `tasks` 父目录，旧实现递归删除项目外 stale lock 和 sentinel；dirfd 实现不改动项目外 lock、sentinel 或 manifest。
- 两个进程按新 Revision、旧 Revision 的顺序执行投影，最终 manifest 仍指向 DB current Revision。
- Task 级 manifest 锁等待上限为 2 秒；超过 30 秒的空锁通过相对 `unlinkat(AT_REMOVEDIR)` 回收，非空锁保留。释放前通过已打开 fd 的 device/inode 校验锁所有权。
- draft 并发失败证据为 transient `task_revision_locked`；仅该类错误执行 5 次以内指数退避，唯一性冲突不重试。
- `task-fs.test.ts`、`task.test.ts`、`runs.test.ts` 与 Runs API 测试连续三轮均为 56 pass、0 fail；每轮 292 个断言。
