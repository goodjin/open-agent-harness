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
- 每个 Task 在已打开的 Task 目录内保留一个 regular `.manifest.lock` 文件。进程通过 `flock(LOCK_EX | LOCK_NB)` 有界竞争，持锁期间保留 fd，释放时只执行 `LOCK_UN` 和 close，不 rename 或 unlink 锁文件。进程崩溃后内核释放锁。锁内读取 DB 当前 Revision 后生成 manifest，旧 effect 只发布自己的 immutable revision 文档。
- 旧版 sibling lock 使用 `O_NONBLOCK | O_NOFOLLOW` 相对打开并通过 fd 检查存在性。FIFO 不再阻塞；目录、socket、device 与其他非 regular 节点都原样保留并 fail closed。
- 新目录创建成功后 fsync 父目录；temp rename 成功后 fsync 目标目录；首次创建 `.manifest.lock` 后 fsync Task 目录。任一同步失败都使投影返回 `false`，清理残留 temp，并保留已提交的 Task DB 数据。
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
- 旧版本遗留的 sibling `<task_id>.manifest.lock` 节点不会自动回收。只要该节点存在，投影便 fail closed 并原样保留；需要人工确认没有 owner 后清理，或由后续迁移工具处理。投影失败不影响已经提交的 Task DB 数据。
- 目录 fsync 只在已启用 native backend 的 Darwin/Linux 上执行。若挂载文件系统不支持目录 fsync 或 syscall 返回错误，投影 fail closed；运行时不会跳过持久化屏障或改用 path API。
- `bun:ffi` backend 只在 Darwin 或 Linux 成功加载当前 libc 时启用。Linux 先从 `/proc/self/maps` 查找进程实际加载的 glibc 或 musl，再尝试标准 glibc 名称。Windows、静态 musl 或符号加载失败时不使用 path API 回退，投影返回 `false`，Task DB 提交与读取保持可用。
- [Bun FFI 文档](https://bun.sh/docs/runtime/ffi)仍将 `bun:ffi` 标为 experimental，并建议生产 native 集成优先使用 Node-API。当前实现把 FFI 封装在一个内部文件并为加载失败提供安全降级；若以后要求 Windows 也具备文档投影，需引入经过发行矩阵验证的 Node-API/native helper，而不是手写 `NtCreateFile` 结构体绑定。

## 验证结果

- canonical ActionResult 缺字段、raw action id 不一致和非 canonical fallback 均被拒绝；合法结果保持可读。
- 在最后一次校验后替换 revision 父目录并投放同名 temp，旧实现把攻击者 temp rename 成项目外 `task.md`；dirfd 实现保留攻击者文件，只在已打开目录内完成可信 rename。
- 在 manifest lock 获取前替换 `tasks` 父目录，旧实现递归删除项目外 stale lock 和 sentinel；dirfd 实现不改动项目外 lock、sentinel 或 manifest。
- 两个进程按新 Revision、旧 Revision 的顺序执行投影，最终 manifest 仍指向 DB current Revision。
- Task 级 `flock` 等待上限为 2 秒。正常释放和进程退出都由内核解除锁；持久 lock file 不删除。跨进程测试覆盖 contender 超时、正常释放后重新获取，以及 owner `process.exit` 后重新获取。
- 旧版 sibling lock 的真实 FIFO 与 Unix socket 回归覆盖了非阻塞 fail-closed；注入式 syscall seam 通过真实 fsync 计数验证 mkdir、rename 和首次 lock 创建，并验证 fsync/flock 异常不会遗留 temp 或打开的 fd。
- draft 并发失败证据为 transient `task_revision_locked`；仅该类错误执行 5 次以内指数退避，唯一性冲突不重试。
- `task-fs.test.ts`、`task.test.ts`、`runs.test.ts` 与 Runs API 测试连续三轮均为 66 pass、0 fail；每轮 332 个断言。
