import { closeSync, fchmodSync, fstatSync, fsyncSync, writeFileSync } from "fs"
import { dlopen, ptr, read } from "bun:ffi"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Native } from "@/util/native"

export namespace TaskFS {
  type Result = { ok: true; value: number } | { ok: false; errno: number }
  type Native = {
    open(dir: number, name: string, flags: number, mode?: number): Result
    mkdir(dir: number, name: string, mode: number): Result
    rename(dir: number, from: string, to: string): Result
    unlink(dir: number, name: string, flags: number): Result
    flock(fd: number, op: number): Result
    close(): void
  }
  type Hooks = {
    backend?: null
    publish?: (tmp: string) => void
    lock?: () => void
    sync?: (fd: number, kind: "file" | "directory") => void
    flock?: (fd: number, op: number, next: () => Result) => Result
  }

  const ids = /^[A-Za-z0-9._-]+$/
  const log = Log.create({ service: "session.task.fs" })
  const errno = {
    exist: 17,
    missing: 2,
    ...Native.errno,
  }
  const flags =
    process.platform === "darwin"
      ? {
          cwd: -2,
          readonly: 0,
          readwrite: 2,
          write: 1,
          create: 0x200,
          exclusive: 0x800,
          nofollow: 0x100,
          directory: 0x100000,
          cloexec: 0x1000000,
          nonblock: 0x4,
        }
      : {
          cwd: -100,
          readonly: 0,
          readwrite: 2,
          write: 1,
          create: 0x40,
          exclusive: 0x80,
          nofollow: 0x20000,
          directory: 0x10000,
          cloexec: 0x80000,
          nonblock: 0x800,
        }

  const flock = { exclusive: 2, nonblock: 4, unlock: 8 }

  let hooks: Hooks = {}
  let source: string | null | undefined

  export function segment(value: string) {
    return ids.test(value) && value !== "." && value !== ".." && !value.includes("\\") && !value.includes("\0")
  }

  export function publish(root: string[], parts: string[], body: string) {
    if (root.length < 1 || parts.length < 1 || [...root, ...parts].some((part) => !segment(part))) return false
    const native = load()
    if (!native) return false
    let dir = -1
    let file = -1
    let tmp = ""
    try {
      dir = walk(native, [...root, ...parts.slice(0, -1)])
      if (dir < 0) return false
      tmp = `${parts.at(-1)}.${process.pid}.${crypto.randomUUID()}.tmp`
      const opened = call(() => native.open(dir, tmp, fileflags(), 0o600))
      if (!opened.ok) return false
      file = opened.value
      fchmodSync(file, 0o600)
      writeFileSync(file, body, { encoding: "utf8" })
      sync(file, "file")
      hooks.publish?.(tmp)
      if (!call(() => native.rename(dir, tmp, parts.at(-1)!)).ok) return false
      sync(dir, "directory")
      tmp = ""
      return true
    } catch {
      return false
    } finally {
      finish(file)
      if (tmp && dir >= 0) {
        try {
          const removed = call(() => native.unlink(dir, tmp, 0))
          if (!removed.ok && removed.errno !== errno.missing)
            log.warn("task temp cleanup failed", { errno: removed.errno })
        } catch {}
      }
      finish(dir)
      native.close()
    }
  }

  export function manifest(root: string[], body: () => string | undefined) {
    if (root.some((part) => !segment(part)) || root.length < 1) return false
    const native = load()
    if (!native) return false
    let tasks = -1
    let task = -1
    let owner = -1
    try {
      tasks = walk(native, root.slice(0, -1))
      if (tasks < 0) return false
      task = child(native, tasks, root.at(-1)!)
      if (task < 0) return false
      hooks.lock?.()
      if (!missing(native, tasks, `${root.at(-1)}.manifest.lock`)) return false
      owner = acquire(native, task)
      if (owner < 0) return false
      const value = body()
      if (value === undefined) return false
      return write(native, task, "manifest.md", value)
    } catch {
      return false
    } finally {
      try {
        if (owner >= 0) call(() => locking(native, owner, flock.unlock))
      } catch {
      } finally {
        finish(owner)
        finish(task)
        finish(tasks)
        native.close()
      }
    }
  }

  export function testing(next: Hooks) {
    const prev = hooks
    hooks = next
    return {
      [Symbol.dispose]() {
        hooks = prev
      },
    }
  }

  function write(native: Native, dir: number, name: string, body: string) {
    let fd = -1
    let tmp = `${name}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      const opened = call(() => native.open(dir, tmp, fileflags(), 0o600))
      if (!opened.ok) return false
      fd = opened.value
      fchmodSync(fd, 0o600)
      writeFileSync(fd, body, { encoding: "utf8" })
      sync(fd, "file")
      if (!call(() => native.rename(dir, tmp, name)).ok) return false
      sync(dir, "directory")
      tmp = ""
      return true
    } finally {
      finish(fd)
      if (tmp) call(() => native.unlink(dir, tmp, 0))
    }
  }

  function walk(native: Native, parts: string[]) {
    const opened = call(() => native.open(flags.cwd, Instance.directory, dirflags()))
    if (!opened.ok) return -1
    let dir = opened.value
    try {
      for (const part of parts) {
        const next = child(native, dir, part)
        finish(dir)
        dir = -1
        if (next < 0) return -1
        dir = next
      }
      const result = dir
      dir = -1
      return result
    } catch {
      return -1
    } finally {
      finish(dir)
    }
  }

  function child(native: Native, dir: number, name: string) {
    const made = call(() => native.mkdir(dir, name, 0o700))
    if (!made.ok && made.errno !== errno.exist) return -1
    if (made.ok) sync(dir, "directory")
    const opened = call(() => native.open(dir, name, dirflags()))
    return opened.ok ? opened.value : -1
  }

  function acquire(native: Native, dir: number) {
    const made = call(() =>
      native.open(
        dir,
        ".manifest.lock",
        flags.readwrite | flags.create | flags.exclusive | flags.nofollow | flags.cloexec,
        0o600,
      ),
    )
    const opened = made.ok
      ? made
      : made.errno === errno.exist
        ? call(() => native.open(dir, ".manifest.lock", flags.readwrite | flags.nofollow | flags.cloexec))
        : made
    if (!opened.ok) return -1
    const fd = opened.value
    let keep = false
    try {
      fchmodSync(fd, 0o600)
      if (!fstatSync(fd).isFile()) return -1
      if (made.ok) sync(dir, "directory")
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const locked = call(() => locking(native, fd, flock.exclusive | flock.nonblock))
        if (locked.ok) {
          keep = true
          return fd
        }
        if (locked.errno !== errno.blocked) return -1
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      return -1
    } catch {
      return -1
    } finally {
      if (!keep) finish(fd)
    }
  }

  function missing(native: Native, dir: number, name: string) {
    const opened = call(() => native.open(dir, name, flags.readonly | flags.nonblock | flags.nofollow | flags.cloexec))
    if (!opened.ok) return opened.errno === errno.missing
    try {
      fstatSync(opened.value)
      return false
    } catch {
      return false
    } finally {
      finish(opened.value)
    }
  }

  function sync(fd: number, kind: "file" | "directory") {
    if (hooks.sync) return hooks.sync(fd, kind)
    fsyncSync(fd)
  }

  function locking(native: Native, fd: number, op: number) {
    if (hooks.flock) return hooks.flock(fd, op, () => native.flock(fd, op))
    return native.flock(fd, op)
  }

  function finish(fd: number) {
    if (fd < 0) return
    try {
      closeSync(fd)
    } catch {}
  }

  function call(fn: () => Result): Result {
    for (;;) {
      const result = fn()
      if (result.ok || result.errno !== errno.interrupt) return result
    }
  }

  function dirflags() {
    return flags.readonly | flags.directory | flags.nofollow | flags.cloexec
  }

  function fileflags() {
    return flags.write | flags.create | flags.exclusive | flags.nofollow | flags.cloexec
  }

  function load() {
    if (hooks.backend === null) return
    if (source === null) return
    if (process.platform !== "darwin" && process.platform !== "linux") {
      source = null
      log.warn("task markdown projection disabled", { platform: process.platform, reason: "unsupported_platform" })
      return
    }
    for (const file of source ? [source] : Native.libraries()) {
      try {
        const native = library(file)
        source = file
        return native
      } catch {}
    }
    source = null
    log.warn("task markdown projection disabled", { platform: process.platform, reason: "native_backend_unavailable" })
  }

  function library(file: string): Native {
    const shared = {
      openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
      renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
      unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
      flock: { args: ["i32", "i32"], returns: "i32" },
    } as const
    const text = (value: string) => ptr(Buffer.from(`${value}\0`))
    if (process.platform === "darwin") {
      const lib = dlopen(file, { ...shared, __error: { args: [], returns: "ptr" } })
      const result = (value: number): Result => {
        if (value >= 0) return { ok: true, value }
        const error = lib.symbols.__error()
        return { ok: false, errno: error ? read.i32(error, 0) : -1 }
      }
      return {
        open: (dir, name, value, mode = 0) => result(lib.symbols.openat(dir, text(name), value, mode)),
        mkdir: (dir, name, mode) => result(lib.symbols.mkdirat(dir, text(name), mode)),
        rename: (dir, from, to) => result(lib.symbols.renameat(dir, text(from), dir, text(to))),
        unlink: (dir, name, value) => result(lib.symbols.unlinkat(dir, text(name), value)),
        flock: (fd, op) => result(lib.symbols.flock(fd, op)),
        close: () => {
          try {
            lib.close()
          } catch {}
        },
      }
    }
    const lib = dlopen(file, { ...shared, __errno_location: { args: [], returns: "ptr" } })
    const result = (value: number): Result => {
      if (value >= 0) return { ok: true, value }
      const error = lib.symbols.__errno_location()
      return { ok: false, errno: error ? read.i32(error, 0) : -1 }
    }
    return {
      open: (dir, name, value, mode = 0) => result(lib.symbols.openat(dir, text(name), value, mode)),
      mkdir: (dir, name, mode) => result(lib.symbols.mkdirat(dir, text(name), mode)),
      rename: (dir, from, to) => result(lib.symbols.renameat(dir, text(from), dir, text(to))),
      unlink: (dir, name, value) => result(lib.symbols.unlinkat(dir, text(name), value)),
      flock: (fd, op) => result(lib.symbols.flock(fd, op)),
      close: () => {
        try {
          lib.close()
        } catch {}
      },
    }
  }
}
