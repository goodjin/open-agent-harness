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
})
