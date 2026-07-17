import path from "path"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs"
import { lstat, open, realpath } from "fs/promises"
import z from "zod"
import { Instance } from "@/project/instance"
import { Database, and, eq } from "@/storage/db"
import { SessionTaskTable, TaskRevisionTable } from "./session.sql"
import { SessionID } from "./schema"

export namespace Markdown {
  const ids = /^[A-Za-z0-9._-]+$/

  export function segment(value: string) {
    return ids.test(value) && value !== "." && value !== ".."
  }

  export async function directory(parts: string[]) {
    if (parts.some((part) => !segment(part))) return
    const dir = parts.reduce((root, part) => path.join(root, part), Instance.directory)
    const stats = await Promise.all(
      parts.map((_, index) =>
        lstat(parts.slice(0, index + 1).reduce((root, part) => path.join(root, part), Instance.directory)).catch(
          () => undefined,
        ),
      ),
    )
    if (stats.some((stat) => !stat?.isDirectory() || stat.isSymbolicLink())) return
    return dir
  }

  export async function target(root: string[], parts: string[]) {
    if (parts.some((part) => !segment(part))) return
    const dir = await directory(root)
    if (!dir) return
    const file = parts.reduce((base, part) => path.join(base, part), dir)
    const stats = await Promise.all(
      parts.map((_, index) =>
        lstat(parts.slice(0, index + 1).reduce((base, part) => path.join(base, part), dir)).catch(() => undefined),
      ),
    )
    if (stats.some((stat) => !stat || stat.isSymbolicLink())) return
    const project = await realpath(Instance.directory).catch(() => undefined)
    const base = await realpath(dir).catch(() => undefined)
    const target = await realpath(file).catch(() => undefined)
    if (!project || !base || !target) return
    if (base !== root.reduce((value, part) => path.join(value, part), project)) return
    if (!target.startsWith(base + path.sep)) return
    return { base, dir, file, target }
  }

  export async function read(root: string[], parts: string[]) {
    const safe = await target(root, parts)
    if (!safe) return
    const handle = await open(safe.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
    if (!handle) return
    return (async () => {
      const opened = await handle.stat().catch(() => undefined)
      const expected = await lstat(safe.target).catch(() => undefined)
      const current = await realpath(safe.file).catch(() => undefined)
      const live = await realpath(safe.dir).catch(() => undefined)
      if (!opened?.isFile() || !expected?.isFile()) return
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) return
      if (current !== safe.target || live !== safe.base) return
      return handle.readFile({ encoding: "utf8" })
    })().finally(() => handle.close())
  }

  export function publish(root: string[], parts: string[], body: string, probe?: () => void) {
    if ([...root, ...parts].some((part) => !segment(part))) return false
    try {
      const dirs = [...root, ...parts.slice(0, -1)]
      const paths = dirs.reduce<string[]>((out, part) => {
        const base = out.at(-1) ?? Instance.directory
        const dir = path.join(base, part)
        if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { recursive: true })
        return [...out, dir]
      }, [])
      const saved = snapshot(paths)
      probe?.()
      if (!stable(saved)) return false
      const file = [...root, ...parts].reduce((base, part) => path.join(base, part), Instance.directory)
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const opened = fstatSync(fd)
      try {
        writeFileSync(fd, body, { encoding: "utf8" })
        fsyncSync(fd)
        if (!stable(saved) || !same(tmp, opened)) return false
        renameSync(tmp, file)
      } finally {
        closeSync(fd)
        if (same(tmp, opened)) rmSync(tmp, { force: true })
      }
      return true
    } catch {
      return false
    }
  }

  function snapshot(paths: string[]) {
    const root = realpathSync(Instance.directory)
    return paths.map((dir) => {
      const stat = lstatSync(dir)
      const real = realpathSync(dir)
      const rel = path.relative(Instance.directory, dir)
      if (!stat.isDirectory() || stat.isSymbolicLink() || real !== path.join(root, rel))
        throw new Error("unsafe_markdown_directory")
      return { dir, dev: stat.dev, ino: stat.ino, real }
    })
  }

  function stable(saved: ReturnType<typeof snapshot>) {
    return saved.every((item) => {
      const stat = lstatSync(item.dir, { throwIfNoEntry: false })
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return false
      return stat.dev === item.dev && stat.ino === item.ino && realpathSync(item.dir) === item.real
    })
  }

  function same(file: string, opened: ReturnType<typeof fstatSync>) {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    return !!stat?.isFile() && !stat.isSymbolicLink() && stat.dev === opened.dev && stat.ino === opened.ino
  }
}

export namespace TaskDocuments {
  const Input = z
    .object({
      sessionID: SessionID.zod,
      taskID: z.string().min(1),
      version: z.number().int().positive(),
      title: z.string().min(1),
      body: z.string(),
      current: z.boolean(),
    })
    .strict()

  export const Content = z
    .object({
      path: z.string(),
      body: z.string(),
      drifted: z.boolean(),
    })
    .strict()
  export type Content = z.infer<typeof Content>

  export function publish(raw: z.input<typeof Input>) {
    const input = Input.parse(raw)
    const root = [".harness", "sessions", input.sessionID, "tasks", input.taskID]
    const saved = Markdown.publish(root, ["revisions", `v${input.version}`, "task.md"], input.body)
    if (!saved || !input.current) return saved
    return manifest(input.sessionID, input.taskID, root) && saved
  }

  export async function read(sessionID: SessionID, taskID: string, version: unknown) {
    const parsed = z.number().int().positive().safeParse(version)
    if (!parsed.success || !Markdown.segment(taskID)) return
    const row = Database.use((db) =>
      db
        .select({ body_hash: TaskRevisionTable.body_hash })
        .from(TaskRevisionTable)
        .innerJoin(SessionTaskTable, eq(SessionTaskTable.id, TaskRevisionTable.task_id))
        .where(
          and(
            eq(SessionTaskTable.session_id, sessionID),
            eq(SessionTaskTable.id, taskID),
            eq(TaskRevisionTable.version, parsed.data),
          ),
        )
        .get(),
    )
    if (!row) return
    const parts = ["revisions", `v${parsed.data}`, "task.md"]
    const body = await Markdown.read([".harness", "sessions", sessionID, "tasks", taskID], parts)
    if (body === undefined) return
    return Content.parse({
      path: parts.join("/"),
      body,
      drifted: hash(body) !== row.body_hash,
    })
  }

  function hash(input: string) {
    return new Bun.CryptoHasher("sha256").update(input).digest("hex")
  }

  function manifest(sessionID: SessionID, taskID: string, root: string[]) {
    const lock = root.reduce((base, part) => path.join(base, part), Instance.directory) + ".manifest.lock"
    const owner = acquire(lock)
    if (!owner) return false
    try {
      const row = Database.use((db) =>
        db
          .select({ title: TaskRevisionTable.title, version: TaskRevisionTable.version })
          .from(SessionTaskTable)
          .innerJoin(TaskRevisionTable, eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id))
          .where(and(eq(SessionTaskTable.session_id, sessionID), eq(SessionTaskTable.id, taskID)))
          .get(),
      )
      if (!row) return false
      return Markdown.publish(
        root,
        ["manifest.md"],
        [
          `# ${row.title}`,
          "",
          `Current revision: v${row.version}`,
          "",
          `Revision document: revisions/v${row.version}/task.md`,
          "",
        ].join("\n"),
      )
    } finally {
      const stat = lstatSync(lock, { throwIfNoEntry: false })
      if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.dev === owner.dev && stat.ino === owner.ino)
        rmSync(lock, { recursive: true, force: true })
    }
  }

  function acquire(lock: string) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      try {
        mkdirSync(lock)
        const stat = lstatSync(lock)
        if (stat.isDirectory() && !stat.isSymbolicLink()) return stat
        return
      } catch (err) {
        const parsed = z.object({ code: z.string() }).safeParse(err)
        if (!parsed.success || parsed.data.code !== "EEXIST") return
        const stat = lstatSync(lock, { throwIfNoEntry: false })
        if (!stat?.isDirectory() || stat.isSymbolicLink()) return
        if (Date.now() - stat.mtimeMs > 30_000) {
          const stale = `${lock}.stale.${process.pid}.${crypto.randomUUID()}`
          try {
            renameSync(lock, stale)
            rmSync(stale, { recursive: true, force: true })
            continue
          } catch {}
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
  }
}
