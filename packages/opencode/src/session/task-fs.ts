import { closeSync, fchmodSync, fstatSync, fsyncSync, readFileSync, writeFileSync } from "fs"
import { dlopen, ptr, read } from "bun:ffi"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace TaskFS {
  type Result = { ok: true; value: number } | { ok: false; errno: number }
  type Native = {
    open(dir: number, name: string, flags: number, mode?: number): Result
    mkdir(dir: number, name: string, mode: number): Result
    rename(dir: number, from: string, to: string): Result
    unlink(dir: number, name: string, flags: number): Result
    close(): void
  }
  type Hooks = {
    backend?: null
    publish?: (tmp: string) => void
    lock?: () => void
  }

  const ids = /^[A-Za-z0-9._-]+$/
  const log = Log.create({ service: "session.task.fs" })
  const errno = {
    exist: 17,
    missing: 2,
    interrupt: 4,
    notempty: process.platform === "darwin" ? 66 : 39,
  }
  const flags =
    process.platform === "darwin"
      ? {
          cwd: -2,
          readonly: 0,
          write: 1,
          create: 0x200,
          exclusive: 0x800,
          nofollow: 0x100,
          directory: 0x100000,
          cloexec: 0x1000000,
          removedir: 0x80,
        }
      : {
          cwd: -100,
          readonly: 0,
          write: 1,
          create: 0x40,
          exclusive: 0x80,
          nofollow: 0x20000,
          directory: 0x10000,
          cloexec: 0x80000,
          removedir: 0x200,
        }

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
      fsyncSync(file)
      hooks.publish?.(tmp)
      if (!call(() => native.rename(dir, tmp, parts.at(-1)!)).ok) return false
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
    const name = `${root.at(-1)}.manifest.lock`
    try {
      tasks = walk(native, root.slice(0, -1))
      if (tasks < 0) return false
      task = child(native, tasks, root.at(-1)!)
      if (task < 0) return false
      hooks.lock?.()
      owner = acquire(native, tasks, name)
      if (owner < 0) return false
      const value = body()
      if (value === undefined) return false
      return write(native, task, "manifest.md", value)
    } catch {
      return false
    } finally {
      try {
        if (owner >= 0 && owned(native, tasks, name, owner)) call(() => native.unlink(tasks, name, flags.removedir))
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
      fsyncSync(fd)
      if (!call(() => native.rename(dir, tmp, name)).ok) return false
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
    const opened = call(() => native.open(dir, name, dirflags()))
    return opened.ok ? opened.value : -1
  }

  function acquire(native: Native, dir: number, name: string) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const made = call(() => native.mkdir(dir, name, 0o700))
      if (made.ok) {
        const opened = call(() => native.open(dir, name, dirflags()))
        return opened.ok ? opened.value : -1
      }
      if (made.errno !== errno.exist) return -1
      const opened = call(() => native.open(dir, name, dirflags()))
      if (!opened.ok) return -1
      const stat = (() => {
        try {
          return fstatSync(opened.value)
        } finally {
          finish(opened.value)
        }
      })()
      if (Date.now() - stat.mtimeMs > 30_000) {
        const removed = call(() => native.unlink(dir, name, flags.removedir))
        if (removed.ok || removed.errno === errno.missing) continue
        if (removed.errno !== errno.notempty) return -1
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return -1
  }

  function owned(native: Native, dir: number, name: string, owner: number) {
    const opened = call(() => native.open(dir, name, dirflags()))
    if (!opened.ok) return false
    try {
      const live = fstatSync(opened.value)
      const held = fstatSync(owner)
      return live.dev === held.dev && live.ino === held.ino
    } catch {
      return false
    } finally {
      finish(opened.value)
    }
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
    for (const file of source ? [source] : libraries()) {
      try {
        const native = library(file)
        source = file
        return native
      } catch {}
    }
    source = null
    log.warn("task markdown projection disabled", { platform: process.platform, reason: "native_backend_unavailable" })
  }

  function libraries() {
    if (process.platform === "darwin") return ["libSystem.B.dylib"]
    const maps = (() => {
      try {
        return readFileSync("/proc/self/maps", "utf8")
      } catch {
        return ""
      }
    })()
    const loaded = maps
      .split("\n")
      .flatMap(
        (line) =>
          line.match(/\s(\/\S*(?:libc\.so(?:\.\d+)*|libc\.musl-[^/\s]+\.so\.1|ld-musl-[^/\s]+\.so\.1))$/)?.[1] ?? [],
      )
    return [...new Set([...loaded, "libc.so.6"])]
  }

  function library(file: string): Native {
    const shared = {
      openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
      renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
      unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
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
      close: () => {
        try {
          lib.close()
        } catch {}
      },
    }
  }
}
