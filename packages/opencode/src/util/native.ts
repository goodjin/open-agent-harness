import { readFileSync } from "fs"
import { dlopen, ptr, read, type FFIFunction } from "bun:ffi"

export namespace Native {
  export type Result = { ok: true; value: number } | { ok: false; errno: number }

  export const errno = {
    interrupt: 4,
    blocked: process.platform === "darwin" ? 35 : process.platform === "win32" ? 33 : 11,
  }

  export function libraries() {
    if (process.platform === "darwin") return ["libSystem.B.dylib"]
    if (process.platform === "win32") return ["kernel32.dll"]
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

  export function unix<const T extends Record<string, FFIFunction>>(file: string, symbols: T) {
    const shared = { flock: { args: ["i32", "i32"], returns: "i32" } } as const
    if (process.platform === "darwin") {
      const lib = dlopen(file, { ...symbols, ...shared, __error: { args: [], returns: "ptr" } })
      const errno = lib.symbols.__error as unknown as () => ReturnType<typeof ptr>
      const lock = lib.symbols.flock as unknown as (fd: number, value: number) => number
      const result = (value: number): Result => {
        if (value >= 0) return { ok: true, value }
        const error = errno()
        return { ok: false, errno: error ? read.i32(error, 0) : -1 }
      }
      return {
        symbols: lib.symbols,
        result,
        flock: (fd: number, value: number) => result(lock(fd, value)),
        close: () => lib.close(),
      }
    }
    const lib = dlopen(file, { ...symbols, ...shared, __errno_location: { args: [], returns: "ptr" } })
    const errno = lib.symbols.__errno_location as unknown as () => ReturnType<typeof ptr>
    const lock = lib.symbols.flock as unknown as (fd: number, value: number) => number
    const result = (value: number): Result => {
      if (value >= 0) return { ok: true, value }
      const error = errno()
      return { ok: false, errno: error ? read.i32(error, 0) : -1 }
    }
    return {
      symbols: lib.symbols,
      result,
      flock: (fd: number, value: number) => result(lock(fd, value)),
      close: () => lib.close(),
    }
  }
}
