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
  test("discards writes and effects when a transaction inside use fails", () => {
    const effects: string[] = []

    Database.use((db) => {
      db.run(sql`CREATE TABLE effect_test (id INTEGER PRIMARY KEY)`)
      expect(() =>
        Database.transaction((tx) => {
          tx.run(sql`INSERT INTO effect_test (id) VALUES (1)`)
          Database.effect(() => effects.push("failed"))
          throw new Error("rollback")
        }),
      ).toThrow("rollback")
      expect(db.all(sql`SELECT id FROM effect_test`)).toEqual([])
    })

    expect(effects).toEqual([])
  })

  test("runs committed transaction effects after the outer use succeeds", () => {
    const effects: string[] = []

    Database.use((db) => {
      effects.push("outer")
      Database.transaction((tx) => {
        tx.run(sql`CREATE TABLE effect_test (id INTEGER PRIMARY KEY)`)
        Database.effect(() => effects.push("first"))
        Database.effect(() => effects.push("second"))
      })
      expect(effects).toEqual(["outer"])
      expect(db.all(sql`SELECT id FROM effect_test`)).toEqual([])
    })

    expect(effects).toEqual(["outer", "first", "second"])
  })

  test("discards merged transaction effects when the outer use later fails", () => {
    const effects: string[] = []

    expect(() =>
      Database.use(() => {
        Database.transaction((tx) => {
          tx.run(sql`CREATE TABLE effect_test (id INTEGER PRIMARY KEY)`)
          Database.effect(() => effects.push("transaction"))
        })
        throw new Error("outer")
      }),
    ).toThrow("outer")

    expect(effects).toEqual([])
    expect(Database.use((db) => db.all(sql`SELECT id FROM effect_test`))).toEqual([])
  })

  test("discards nested effects and writes when the outer transaction fails", () => {
    const effects: string[] = []
    Database.use((db) => db.run(sql`CREATE TABLE effect_test (id INTEGER PRIMARY KEY)`))

    expect(() =>
      Database.transaction((tx) => {
        Database.transaction((nested) => {
          expect(nested).toBe(tx)
          nested.run(sql`INSERT INTO effect_test (id) VALUES (1)`)
          Database.effect(() => effects.push("nested"))
        })
        throw new Error("outer")
      }),
    ).toThrow("outer")

    expect(effects).toEqual([])
    expect(Database.use((db) => db.all(sql`SELECT id FROM effect_test`))).toEqual([])
  })

  test("discards transaction effects when commit fails", () => {
    const effects: string[] = []
    Database.use((db) => {
      db.run(sql`CREATE TABLE effect_parent (id INTEGER PRIMARY KEY)`)
      db.run(
        sql`CREATE TABLE effect_child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES effect_parent(id) DEFERRABLE INITIALLY DEFERRED
        )`,
      )
    })

    expect(() =>
      Database.transaction((tx) => {
        tx.run(sql`INSERT INTO effect_child (id, parent_id) VALUES (1, 1)`)
        Database.effect(() => effects.push("commit"))
      }),
    ).toThrow()

    expect(effects).toEqual([])
    expect(Database.use((db) => db.all(sql`SELECT id FROM effect_child`))).toEqual([])
  })

  test("commits before running effects and keeps their existing failure order", () => {
    const effects: string[] = []
    Database.use((db) => db.run(sql`CREATE TABLE effect_test (id INTEGER PRIMARY KEY)`))

    expect(() =>
      Database.transaction((tx) => {
        tx.run(sql`INSERT INTO effect_test (id) VALUES (1)`)
        Database.effect(() => {
          effects.push("failed")
          throw new Error("effect")
        })
        Database.effect(() => effects.push("skipped"))
      }),
    ).toThrow("effect")

    expect(effects).toEqual(["failed"])
    expect(Database.use((db) => db.all(sql`SELECT id FROM effect_test`))).toEqual([{ id: 1 }])
  })

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
