import { readFileSync } from "fs"

export namespace Native {
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
}
