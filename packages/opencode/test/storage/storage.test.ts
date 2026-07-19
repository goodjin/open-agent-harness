import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

const posix = process.platform === "darwin" || process.platform === "linux" ? test : test.skip

describe("storage", () => {
  test("creates a new JSON value", async () => {
    const key = ["test", "create", crypto.randomUUID()]
    expect(await Storage.create(key, { value: "first" })).toBe(true)
    expect(await Storage.read<{ value: string }>(key)).toEqual({ value: "first" })
  })

  test("does not replace an existing JSON value", async () => {
    const key = ["test", "create", crypto.randomUUID()]
    expect(await Storage.create(key, { value: "first" })).toBe(true)
    expect(await Storage.create(key, { value: "second" })).toBe(false)
    expect(await Storage.read<{ value: string }>(key)).toEqual({ value: "first" })
  })

  test("publishes exactly one complete winner under concurrency", async () => {
    const key = ["test", "create", crypto.randomUUID()]
    const values = Array.from({ length: 32 }, (_, index) => ({ index, text: String(index).repeat(4096) }))
    const created = await Promise.all(values.map((value) => Storage.create(key, value)))
    expect(created.filter(Boolean)).toHaveLength(1)
    expect(values).toContainEqual(await Storage.read<(typeof values)[number]>(key))
  })

  test("ignores non-JSON files and leaves no temporary files", async () => {
    const prefix = ["test", "create", crypto.randomUUID()]
    const dir = path.join(Global.Path.data, "storage", ...prefix)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "orphan.tmp"), "partial")
    expect(await Storage.create([...prefix, "value"], { complete: true })).toBe(true)
    expect(await Storage.create([...prefix, "value"], { complete: false })).toBe(false)

    expect(await Storage.list(prefix)).toEqual([[...prefix, "value"]])
    expect((await fs.readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual(["orphan.tmp"])
  })

  posix("serializes real processes on one kernel lock", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = path.join(Global.Path.data, `lock-test-${crypto.randomUUID()}`)
    const owner = locker(key, path.join(dir, "owner"), path.join(dir, "release"))
    await ready(path.join(dir, "owner"))
    const next = locker(key, path.join(dir, "next"), path.join(dir, "release-next"))
    await Bun.sleep(100)
    expect(await Bun.file(path.join(dir, "next")).exists()).toBe(false)
    await Bun.write(path.join(dir, "release"), "release")
    expect(await owner.exited).toBe(0)
    await ready(path.join(dir, "next"))
    await Bun.write(path.join(dir, "release-next"), "release")
    expect(await next.exited).toBe(0)
  })

  posix("times out without stealing or breaking a live process lock", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = path.join(Global.Path.data, `lock-test-${crypto.randomUUID()}`)
    const owner = locker(key, path.join(dir, "owner"), path.join(dir, "release"))
    await ready(path.join(dir, "owner"))

    await expect(Storage.locked(key, async () => {}, { timeout: 30 })).rejects.toBeInstanceOf(
      Storage.LockTimeoutError,
    )
    expect(owner.killed).toBe(false)
    await Bun.write(path.join(dir, "release"), "release")
    expect(await owner.exited).toBe(0)
    expect(await Storage.locked(key, async () => "released", { timeout: 100 })).toBe("released")
  })

  posix("releases a process lock when its owner is killed", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = path.join(Global.Path.data, `lock-test-${crypto.randomUUID()}`)
    const owner = locker(key, path.join(dir, "owner"), path.join(dir, "never"))
    await ready(path.join(dir, "owner"))
    owner.kill("SIGKILL")
    await owner.exited

    expect(await Storage.locked(key, async () => "recovered", { timeout: 500 })).toBe("recovered")
  }, 15_000)

  posix("releases a lock when the protected callback throws", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    await expect(
      Storage.locked(key, async () => {
        throw new Error("callback failed")
      }),
    ).rejects.toThrow("callback failed")
    expect(await Storage.locked(key, async () => "released", { timeout: 100 })).toBe("released")
  })

  posix("keeps lock files out of storage listings", async () => {
    const prefix = ["test", "lock", crypto.randomUUID()]
    await Storage.write([...prefix, "value"], { complete: true })
    await Storage.locked([...prefix, "manifest"], async () => {})

    expect(await Storage.list(prefix)).toEqual([[...prefix, "value"]])
    expect((await fs.stat(lockfile([...prefix, "manifest"]))).isFile()).toBe(true)
  })
})

function lockfile(key: string[]) {
  return path.join(Global.Path.data, "storage", ...key) + ".lock"
}

function locker(key: string[], ready: string, release: string) {
  return Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { Storage } from "./src/storage/storage.ts"
        import { existsSync } from "fs"
        await Storage.locked(JSON.parse(process.env.LOCK_KEY), async () => {
          await Bun.write(process.env.LOCK_READY, "ready")
          while (!existsSync(process.env.LOCK_RELEASE)) await Bun.sleep(5)
        })
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        LOCK_KEY: JSON.stringify(key),
        LOCK_READY: ready,
        LOCK_RELEASE: release,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

async function ready(file: string) {
  for (let count = 0; count < 2_000; count++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${file}`)
}
