import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Installation } from "../../src/installation"
import { Database, sql } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const file = path.basename(Database.Path)
    const expected = ["latest", "beta"].includes(Installation.CHANNEL)
      ? "opencode.db"
      : `opencode-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
    expect(file).toBe(expected)
  })
})

describe("Database.transaction", () => {
  test("waits for the write lock before an immediate transaction callback", async () => {
    Database.Client()
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import { Database } from "bun:sqlite"
          const db = new Database(process.env.DB_PATH)
          db.run("PRAGMA busy_timeout = 1000")
          db.run("BEGIN IMMEDIATE")
          console.log("locked")
          await Bun.sleep(250)
          db.run("COMMIT")
          db.close()
        `,
      ],
      {
        cwd: path.join(import.meta.dir, "../.."),
        env: { ...process.env, DB_PATH: Database.Path },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const reader = proc.stdout.getReader()
    const signal = await reader.read()
    expect(new TextDecoder().decode(signal.value)).toContain("locked")

    const start = Date.now()
    Database.transaction((db) => db.run(sql`SELECT 1`), { behavior: "immediate" })
    expect(Date.now() - start).toBeGreaterThanOrEqual(150)
    expect(await proc.exited).toBe(0)
  })
})
