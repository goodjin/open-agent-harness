import { closeSync, constants, fchmodSync, fstatSync, openSync } from "fs"
import { dlopen, ptr, read } from "bun:ffi"
import path from "path"
import { Native } from "./native"

export namespace FileLock {
  export type Result = { ok: true; value: number } | { ok: false; errno: number }
  export type Backend = {
    open(file: string): number
    regular(fd: number): boolean
    lock(fd: number): Result
    unlock(fd: number): Result
    release(fd: number): void
    close(): void
    interrupt?: number
  }
  type Hooks = { load?: () => Backend | undefined }

  let hooks: Hooks = {}

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
    if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout < 0)
      throw new RangeError("File lock timeout must be a finite nonnegative integer")
    const native = hooks.load ? hooks.load() : load()
    if (!native) throw new UnsupportedError()
    let fd = -1
    let locked = false
    try {
      fd = native.open(file)
      if (!native.regular(fd)) throw new Error(`File lock target is not a regular file: ${file}`)
      const end = Date.now() + timeout
      while (true) {
        const result = call(() => native.lock(fd), native.interrupt)
        if (result.ok) {
          locked = true
          return await fn()
        }
        if (result.errno !== Native.errno.blocked)
          throw new Error(`File lock failed with errno ${result.errno}: ${file}`)
        if (Date.now() >= end) throw new TimeoutError()
        await Bun.sleep(10)
      }
    } finally {
      try {
        if (locked) call(() => native.unlock(fd), native.interrupt)
      } catch {}
      try {
        if (fd >= 0) native.release(fd)
      } catch {}
      try {
        native.close()
      } catch {}
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

  function call(fn: () => Result, interrupt?: number): Result {
    while (true) {
      const result = fn()
      if (result.ok || interrupt === undefined || result.errno !== interrupt) return result
    }
  }

  function load() {
    if (process.platform === "win32") return windows()
    if (process.platform !== "darwin" && process.platform !== "linux") return
    for (const file of Native.libraries()) {
      try {
        return unix(file)
      } catch {}
    }
  }

  function unix(file: string): Backend {
    const symbols = { flock: { args: ["i32", "i32"], returns: "i32" } } as const
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | cloexec()
    if (process.platform === "darwin") {
      const lib = dlopen(file, { ...symbols, __error: { args: [], returns: "ptr" } })
      const flock = (fd: number, value: number): Result => {
        const result = lib.symbols.flock(fd, value)
        if (result >= 0) return { ok: true, value: result }
        const error = lib.symbols.__error()
        return { ok: false, errno: error ? read.i32(error, 0) : -1 }
      }
      return {
        open: (path) => openSync(path, flags, 0o600),
        regular: (fd) => (fchmodSync(fd, 0o600), fstatSync(fd).isFile()),
        lock: (fd) => flock(fd, 2 | 4),
        unlock: (fd) => flock(fd, 8),
        release: closeSync,
        close: () => lib.close(),
        interrupt: Native.errno.interrupt,
      }
    }
    const lib = dlopen(file, { ...symbols, __errno_location: { args: [], returns: "ptr" } })
    const flock = (fd: number, value: number): Result => {
      const result = lib.symbols.flock(fd, value)
      if (result >= 0) return { ok: true, value: result }
      const error = lib.symbols.__errno_location()
      return { ok: false, errno: error ? read.i32(error, 0) : -1 }
    }
    return {
      open: (path) => openSync(path, flags, 0o600),
      regular: (fd) => (fchmodSync(fd, 0o600), fstatSync(fd).isFile()),
      lock: (fd) => flock(fd, 2 | 4),
      unlock: (fd) => flock(fd, 8),
      release: closeSync,
      close: () => lib.close(),
      interrupt: Native.errno.interrupt,
    }
  }

  function windows(): Backend | undefined {
    try {
      const lib = dlopen("kernel32.dll", {
        CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
        UnlockFileEx: { args: ["u64", "u32", "u32", "u32", "ptr"], returns: "i32" },
        GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
        GetLastError: { args: [], returns: "u32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
      })
      const handles = new Map<number, { handle: bigint; overlap: BigUint64Array }>()
      let next = 0
      const result = (ok: number): Result =>
        ok ? { ok: true, value: ok } : { ok: false, errno: lib.symbols.GetLastError() }
      return {
        open(file) {
          const target = path.toNamespacedPath(path.resolve(file))
          const text = new Uint16Array(target.length + 1)
          for (let index = 0; index < target.length; index++) text[index] = target.charCodeAt(index)
          const handle = lib.symbols.CreateFileW(ptr(text), 0xc0000000, 3, null, 4, 0x200080, 0n)
          if (handle === 0xffffffffffffffffn)
            throw new Error(`CreateFileW failed with errno ${lib.symbols.GetLastError()}: ${file}`)
          const fd = next++
          handles.set(fd, { handle, overlap: new BigUint64Array(4) })
          return fd
        },
        regular(fd) {
          const item = handles.get(fd)
          if (!item) return false
          const info = new Uint32Array(2)
          if (!lib.symbols.GetFileInformationByHandleEx(item.handle, 9, ptr(info), info.byteLength)) return false
          return (info[0]! & (0x10 | 0x400)) === 0
        },
        lock(fd) {
          const item = handles.get(fd)
          if (!item) return { ok: false, errno: 6 }
          return result(lib.symbols.LockFileEx(item.handle, 1 | 2, 0, 1, 0, ptr(item.overlap)))
        },
        unlock(fd) {
          const item = handles.get(fd)
          if (!item) return { ok: false, errno: 6 }
          return result(lib.symbols.UnlockFileEx(item.handle, 0, 1, 0, ptr(item.overlap)))
        },
        release(fd) {
          const item = handles.get(fd)
          if (!item) return
          lib.symbols.CloseHandle(item.handle)
          handles.delete(fd)
        },
        close: () => lib.close(),
      }
    } catch {
      return
    }
  }

  function cloexec() {
    if (process.platform === "darwin") return 0x1000000
    return 0x80000
  }
}
