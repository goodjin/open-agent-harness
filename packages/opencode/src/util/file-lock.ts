import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync } from "fs"
import { dlopen, read } from "bun:ffi"

export namespace FileLock {
  type Result = { ok: true; value: number } | { ok: false; errno: number }

  const errno = {
    interrupt: 4,
    blocked: process.platform === "darwin" ? 35 : 11,
  }
  const op = { exclusive: 2, nonblock: 4, unlock: 8 }

  export class UnsupportedError extends Error {
    constructor() {
      super(`Native file locks are unavailable on ${process.platform}`)
      this.name = "FileLockUnsupportedError"
    }
  }

  export class TimeoutError extends Error {
    constructor() {
      super("Timed out waiting for native file lock")
      this.name = "FileLockTimeoutError"
    }
  }

  export async function withLock<T>(file: string, fn: () => Promise<T>, timeout: number) {
    const native = load()
    if (!native) throw new UnsupportedError()
    const flags =
      constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (process.platform === "darwin" ? 0x1000000 : 0x80000)
    const fd = openSync(file, flags, 0o600)
    let locked = false
    try {
      fchmodSync(fd, 0o600)
      if (!fstatSync(fd).isFile()) throw new Error(`File lock target is not a regular file: ${file}`)
      const end = Date.now() + timeout
      while (true) {
        const result = call(() => native.flock(fd, op.exclusive | op.nonblock))
        if (result.ok) {
          locked = true
          return await fn()
        }
        if (result.errno !== errno.blocked) throw new Error(`File lock failed with errno ${result.errno}: ${file}`)
        if (Date.now() >= end) throw new TimeoutError()
        await Bun.sleep(10)
      }
    } finally {
      try {
        if (locked) call(() => native.flock(fd, op.unlock))
      } catch {}
      try {
        closeSync(fd)
      } catch {}
      try {
        native.close()
      } catch {}
    }
  }

  function call(fn: () => Result): Result {
    while (true) {
      const result = fn()
      if (result.ok || result.errno !== errno.interrupt) return result
    }
  }

  function load() {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    for (const file of libraries()) {
      try {
        return library(file)
      } catch {}
    }
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

  function library(file: string) {
    const symbols = { flock: { args: ["i32", "i32"], returns: "i32" } } as const
    if (process.platform === "darwin") {
      const lib = dlopen(file, { ...symbols, __error: { args: [], returns: "ptr" } })
      return {
        flock(fd: number, value: number): Result {
          const result = lib.symbols.flock(fd, value)
          if (result >= 0) return { ok: true, value: result }
          const error = lib.symbols.__error()
          return { ok: false, errno: error ? read.i32(error, 0) : -1 }
        },
        close: () => lib.close(),
      }
    }
    const lib = dlopen(file, { ...symbols, __errno_location: { args: [], returns: "ptr" } })
    return {
      flock(fd: number, value: number): Result {
        const result = lib.symbols.flock(fd, value)
        if (result >= 0) return { ok: true, value: result }
        const error = lib.symbols.__errno_location()
        return { ok: false, errno: error ? read.i32(error, 0) : -1 }
      },
      close: () => lib.close(),
    }
  }
}
