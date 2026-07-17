import path from "path"
import { constants } from "fs"
import { lstat, open, realpath } from "fs/promises"
import z from "zod"
import { Instance } from "@/project/instance"
import { Database, and, eq } from "@/storage/db"
import { SessionTaskTable, TaskRevisionTable } from "./session.sql"
import { SessionID } from "./schema"
import { TaskFS } from "./task-fs"

export namespace Markdown {
  export function segment(value: string) {
    return TaskFS.segment(value)
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

  export function publish(root: string[], parts: string[], body: string) {
    return TaskFS.publish(root, parts, body)
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
    return TaskFS.manifest(root, () => {
      const row = Database.use((db) =>
        db
          .select({ title: TaskRevisionTable.title, version: TaskRevisionTable.version })
          .from(SessionTaskTable)
          .innerJoin(TaskRevisionTable, eq(TaskRevisionTable.id, SessionTaskTable.current_revision_id))
          .where(and(eq(SessionTaskTable.session_id, sessionID), eq(SessionTaskTable.id, taskID)))
          .get(),
      )
      if (!row) return
      return [
        `# ${row.title}`,
        "",
        `Current revision: v${row.version}`,
        "",
        `Revision document: revisions/v${row.version}/task.md`,
        "",
      ].join("\n")
    })
  }
}
