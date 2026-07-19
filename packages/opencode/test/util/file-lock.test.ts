import { expect, test } from "bun:test"
import { FileLock } from "../../src/util/file-lock"

function backend(input: Partial<FileLock.Backend> = {}) {
  return {
    open: () => 7,
    regular: () => true,
    lock: () => ({ ok: true, value: 0 } as const),
    unlock: () => ({ ok: true, value: 0 } as const),
    release() {},
    close() {},
    ...input,
  } satisfies FileLock.Backend
}

test("file lock rejects an unavailable native backend", async () => {
  using hook = FileLock.testing({ load: () => undefined })
  await expect(FileLock.withLock("unused", async () => {}, 0)).rejects.toBeInstanceOf(FileLock.UnsupportedError)
})

test("file lock closes its backend when native open fails", async () => {
  let closed = 0
  using hook = FileLock.testing({
    load: () =>
      backend({
        open() {
          throw new Error("open failed")
        },
        close() {
          closed++
        },
      }),
  })

  await expect(FileLock.withLock("unused", async () => {}, 0)).rejects.toThrow("open failed")
  expect(closed).toBe(1)
})

test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("file lock rejects invalid timeout %p", async (timeout) => {
  let opened = 0
  using hook = FileLock.testing({ load: () => backend({ open: () => ++opened }) })

  await expect(FileLock.withLock("unused", async () => {}, timeout)).rejects.toBeInstanceOf(RangeError)
  expect(opened).toBe(0)
})

test("file lock accepts zero as an immediate nonblocking attempt", async () => {
  const events: string[] = []
  using hook = FileLock.testing({
    load: () =>
      backend({
        lock: () => ({ ok: false, errno: process.platform === "darwin" ? 35 : process.platform === "win32" ? 33 : 11 }),
        release: () => events.push("release"),
        close: () => events.push("close"),
      }),
  })

  await expect(FileLock.withLock("unused", async () => {}, 0)).rejects.toBeInstanceOf(FileLock.TimeoutError)
  expect(events).toEqual(["release", "close"])
})

test("file lock does not retry a backend error without an interrupt contract", async () => {
  let calls = 0
  using hook = FileLock.testing({
    load: () =>
      backend({
        lock: () => (calls++, { ok: false, errno: 4 }),
      }),
  })

  await expect(FileLock.withLock("unused", async () => {}, 10)).rejects.toThrow("errno 4")
  expect(calls).toBe(1)
})

test("file lock unlocks and releases a native handle when the callback fails", async () => {
  const events: string[] = []
  using hook = FileLock.testing({
    load: () =>
      backend({
        unlock: () => (events.push("unlock"), { ok: true, value: 0 }),
        release: () => events.push("release"),
        close: () => events.push("close"),
      }),
  })

  await expect(
    FileLock.withLock(
      "unused",
      async () => {
        throw new Error("callback failed")
      },
      1,
    ),
  ).rejects.toThrow("callback failed")
  expect(events).toEqual(["unlock", "release", "close"])
})
