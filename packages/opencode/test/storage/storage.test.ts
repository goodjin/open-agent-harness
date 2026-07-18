import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

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

  test("never reclaims an aged lock owned by a live process", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = lockdir(key)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, token: "live-owner" }))
    const old = new Date(Date.now() - 120_000)
    await fs.utimes(dir, old, old)

    await expect(Storage.locked(key, async () => {}, { timeout: 30, grace: 5 })).rejects.toBeInstanceOf(
      Storage.LockTimeoutError,
    )
    expect(JSON.parse(await fs.readFile(path.join(dir, "owner.json"), "utf8"))).toEqual({
      pid: process.pid,
      token: "live-owner",
    })
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("reclaims a lock only after its recorded owner dies", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = lockdir(key)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" }))

    expect(await Storage.locked(key, async () => "recovered", { timeout: 100 })).toBe("recovered")
    expect(await fs.stat(dir).then(() => true, () => false)).toBe(false)
  })

  test.each(["missing", "corrupt"])("waits through the %s-owner grace window before recovery", async (kind) => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = lockdir(key)
    await fs.mkdir(dir, { recursive: true })
    if (kind === "corrupt") await fs.writeFile(path.join(dir, "owner.json"), "not-json")

    await expect(Storage.locked(key, async () => {}, { timeout: 20, grace: 100 })).rejects.toBeInstanceOf(
      Storage.LockTimeoutError,
    )
    expect(await fs.stat(dir).then(() => true, () => false)).toBe(true)
    const old = new Date(Date.now() - 1_000)
    await fs.utimes(dir, old, old)
    expect(await Storage.locked(key, async () => "recovered", { timeout: 100, grace: 10 })).toBe("recovered")
  })

  test("does not let an old owner release a replacement token", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = lockdir(key)
    await Storage.locked(key, async () => {
      await fs.writeFile(
        path.join(dir, "owner.json"),
        JSON.stringify({ pid: process.pid, token: "replacement-owner" }),
      )
    })

    expect(JSON.parse(await fs.readFile(path.join(dir, "owner.json"), "utf8"))).toEqual({
      pid: process.pid,
      token: "replacement-owner",
    })
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("serializes concurrent reclaimers without deleting a new owner", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const dir = lockdir(key)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" }))
    const seen: string[] = []
    let active = 0
    let peak = 0
    const run = (name: string) =>
      Storage.locked(
        key,
        async () => {
          active++
          peak = Math.max(peak, active)
          seen.push(name)
          await Bun.sleep(20)
          active--
        },
        { timeout: 1_000, grace: 5 },
      )

    await Promise.all([run("a"), run("b")])
    expect(peak).toBe(1)
    expect(seen.sort()).toEqual(["a", "b"])
    expect((await fs.readdir(path.dirname(dir))).filter((item) => item.includes(path.basename(dir)))).toEqual([])
  })

  test("keeps release and reclaim races mutually exclusive", async () => {
    const key = ["test", "lock", crypto.randomUUID()]
    const gate = Promise.withResolvers<void>()
    const seen: string[] = []
    let active = 0
    let peak = 0
    const first = Storage.locked(key, async () => {
      active++
      peak = Math.max(peak, active)
      seen.push("owner")
      await gate.promise
      active--
    })
    while (!seen.length) await Bun.sleep(5)
    const next = Storage.locked(key, async () => {
      active++
      peak = Math.max(peak, active)
      seen.push("reclaimer")
      active--
    })
    gate.resolve()
    await Promise.all([first, next])

    expect(peak).toBe(1)
    expect(seen).toEqual(["owner", "reclaimer"])
  })
})

function lockdir(key: string[]) {
  return path.join(Global.Path.data, "storage", ...key) + ".lock"
}
