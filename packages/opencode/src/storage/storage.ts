import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { NamedError } from "@open-agent-harness/util/error"
import z from "zod"
import { Glob } from "../util/glob"
import { git } from "@/util/git"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  export const LockTimeoutError = NamedError.create(
    "StorageLockTimeoutError",
    z.object({
      key: z.string(),
      timeout: z.number().int().nonnegative(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      const projectDirs = await Glob.scan("*", {
        cwd: project,
        include: "all",
      })
      for (const projectDir of projectDirs) {
        const fullPath = path.join(project, projectDir)
        if (!(await Filesystem.isDir(fullPath))) continue
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for (const msgFile of await Glob.scan("storage/session/message/*/*.json", {
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Filesystem.readJson<any>(msgFile)
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const result = await git(["rev-list", "--max-parents=0", "--all"], {
            cwd: worktree,
          })
          const [id] = result
            .text()
            .split("\n")
            .filter(Boolean)
            .map((x) => x.trim())
            .toSorted()
          if (!id) continue
          projectID = id

          await Filesystem.writeJson(path.join(dir, "project", projectID + ".json"), {
            id,
            vcs: "git",
            worktree,
            time: {
              created: Date.now(),
              initialized: Date.now(),
            },
          })

          log.info(`migrating sessions for project ${projectID}`)
          for (const sessionFile of await Glob.scan("storage/session/info/*.json", {
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Filesystem.readJson<any>(sessionFile)
            await Filesystem.writeJson(dest, session)
            log.info(`migrating messages for session ${session.id}`)
            for (const msgFile of await Glob.scan(`storage/session/message/${session.id}/*.json`, {
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Filesystem.readJson<any>(msgFile)
              await Filesystem.writeJson(dest, message)

              log.info(`migrating parts for message ${message.id}`)
              for (const partFile of await Glob.scan(`storage/session/part/${session.id}/${message.id}/*.json`, {
                cwd: fullProjectDir,
                absolute: true,
              })) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Filesystem.readJson(partFile)
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Filesystem.writeJson(dest, part)
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for (const item of await Glob.scan("session/*/*.json", {
        cwd: dir,
        absolute: true,
      })) {
        const session = await Filesystem.readJson<any>(item)
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Filesystem.write(path.join(dir, "session_diff", session.id + ".json"), JSON.stringify(diffs))
        await Filesystem.writeJson(path.join(dir, "session", session.projectID, session.id + ".json"), {
          ...session,
          summary: {
            additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
            deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
          },
        })
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Filesystem.readJson<string>(path.join(dir, "migration"))
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Filesystem.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Filesystem.readJson<T>(target)
      return result as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Filesystem.readJson<T>(target)
      fn(content as T)
      await Filesystem.writeJson(target, content)
      return content
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await Filesystem.writeJson(target, content)
    })
  }

  export async function create<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await Filesystem.writeJson(tmp, content)
      return await fs.link(tmp, target).then(
        () => true,
        (err: unknown) => {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") return false
          throw err
        },
      )
    } finally {
      await fs.unlink(tmp).catch((err: unknown) => {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return
        log.warn("storage create cleanup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  export async function exists(key: string[]) {
    const dir = await state().then((x) => x.dir)
    return fs.stat(path.join(dir, ...key) + ".json").then(
      (item) => item.isFile(),
      () => false,
    )
  }

  export async function locked<T>(
    key: string[],
    fn: () => Promise<T>,
    options: { timeout?: number; grace?: number } = {},
  ) {
    const root = await state().then((x) => x.dir)
    const dir = path.join(root, ...key) + ".lock"
    const owner = path.join(dir, "owner.json")
    const timeout = options.timeout ?? 30_000
    const grace = options.grace ?? 1_000
    const end = Date.now() + timeout
    const token = crypto.randomUUID()
    const parse = (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
      const item = raw as { pid?: unknown; token?: unknown }
      if (!Number.isInteger(item.pid) || typeof item.token !== "string" || !item.token) return
      return { pid: item.pid as number, token: item.token }
    }
    const read = () => Filesystem.readJson<unknown>(owner).then(parse).catch(() => undefined)
    const remove = async (expected?: string) => {
      const current = await read()
      if (expected ? current?.token !== expected : current) return false
      await fs.rm(dir, { recursive: true, force: true })
      return true
    }
    while (true) {
      const made = await fs.mkdir(dir, { recursive: false }).then(
        () => true,
        (err: unknown) => {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") return false
          throw err
        },
      )
      if (made === undefined) {
        await fs.mkdir(path.dirname(dir), { recursive: true })
        continue
      }
      if (made) {
        await Filesystem.writeJson(owner, { pid: process.pid, token })
        try {
          return await fn()
        } finally {
          await remove(token)
        }
      }
      const saved = await read()
      const age = await fs.stat(dir).then(
        (item) => Date.now() - item.mtimeMs,
        () => 0,
      )
      const alive = saved
        ? (() => {
            try {
              process.kill(saved.pid, 0)
              return true
            } catch {
              return false
            }
          })()
        : undefined
      if (saved && !alive && (await remove(saved.token))) continue
      if (!saved && age >= grace && (await remove())) {
        continue
      }
      if (Date.now() >= end) throw new LockTimeoutError({ key: key.join("/"), timeout })
      await Bun.sleep(10)
    }
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Glob.scan("**/*.json", {
        cwd: path.join(dir, ...prefix),
        include: "file",
      }).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }

  export async function probe(prefix: string[], limit: number) {
    const size = Math.max(1, Math.floor(limit))
    const dir = await state().then((x) => x.dir)
    const found: string[][] = []
    try {
      const scan = await fs.opendir(path.join(dir, ...prefix))
      for await (const item of scan) {
        if (!item.isFile() || !item.name.endsWith(".json")) continue
        found.push([...prefix, item.name.slice(0, -5)])
        if (found.length === size) break
      }
      return found.sort()
    } catch {
      return []
    }
  }
}
