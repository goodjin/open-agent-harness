import path from "path"
import { constants } from "fs"
import { lstat, open, realpath } from "fs/promises"
import z from "zod"
import { Instance } from "@/project/instance"
import { AgentProtocol } from "@/protocol/schema"
import { Storage } from "@/storage/storage"
import { Session } from "."
import { SessionID } from "./schema"

export namespace SessionRuns {
  const kinds = ["requirements", "designs", "plans", "reviews"] as const
  const ids = /^[A-Za-z0-9._-]+$/

  export const ID = z.string().regex(/^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/)

  export const Document = z
    .object({
      path: z.string(),
      name: z.string(),
      type: z.enum([...kinds, "manifest"]),
      task_id: z.string().optional(),
      size: z.number().int().nonnegative(),
      updated_at: z.number().nonnegative(),
    })
    .strict()
  export type Document = z.infer<typeof Document>

  export const Content = z
    .object({
      document: Document,
      body: z.string(),
    })
    .strict()
  export type Content = z.infer<typeof Content>

  export const Run = AgentProtocol.Result.omit({ status: true })
    .extend({
      status: z.enum(["running", "completed", "blocked", "failed"]),
      documents: z.array(Document).default([]),
    })
    .strict()
  export type Run = z.infer<typeof Run>

  const Active = z
    .object({
      runID: z.string().min(1),
      status: z.literal("running"),
      title: z.string().optional(),
      actions: z.array(AgentProtocol.ResultAction.strip()),
      time: AgentProtocol.Result.shape.time,
      metrics: AgentProtocol.Result.shape.metrics,
    })
    .passthrough()

  export async function list(sessionID: SessionID) {
    const keys = await Storage.list(["session_protocol_run", sessionID])
    const runs = await Promise.all(
      keys.map((key) => Storage.read<AgentProtocol.Result>(key).then(AgentProtocol.Result.parse)),
    )
    const saved = await Promise.all(
      runs.map(async (run) => Run.parse({ ...run, documents: await documents(sessionID, run.run_id) })),
    )
    const out = new Map(saved.map((run) => [run.run_id, run]))
    for (const run of await active(sessionID)) out.set(run.run_id, run)
    return [...out.values()].sort((a, b) => b.time.started - a.time.started || b.run_id.localeCompare(a.run_id))
  }

  export async function get(sessionID: SessionID, runID: string) {
    if (!ID.safeParse(runID).success) return
    const run = await Storage.read<AgentProtocol.Result>(["session_protocol_run", sessionID, runID]).catch(
      () => undefined,
    )
    if (run) return Run.parse({ ...AgentProtocol.Result.parse(run), documents: await documents(sessionID, runID) })
    return (await active(sessionID)).find((item) => item.run_id === runID)
  }

  export async function documents(sessionID: SessionID, runID: string) {
    const dir = await root(sessionID, runID)
    if (!dir) return [] as Document[]
    const files = await Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: dir, absolute: true })).catch(() => [])
    const out = await Promise.all(
      files.map(async (file) => {
        const rel = path.relative(dir, file).split(path.sep).join("/")
        const type = kind(rel)
        if (!type) return
        const safe = await secure(dir, rel.split("/"))
        if (!safe) return
        const stat = await lstat(safe).catch(() => undefined)
        if (!stat?.isFile() || stat.isSymbolicLink()) return
        return Document.parse({
          path: rel,
          name: path.basename(rel),
          type,
          task_id: type === "manifest" ? undefined : path.basename(rel, ".md"),
          size: stat.size,
          updated_at: stat.mtimeMs,
        })
      }),
    )
    return out
      .filter((item): item is Document => item !== undefined)
      .sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path))
  }

  export async function read(sessionID: SessionID, runID: string, rel: string) {
    const file = await target(sessionID, runID, rel)
    if (!file) return
    const stat = await lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink()) return
    const type = kind(rel)
    if (!type) return
    const body = await content(sessionID, runID, file)
    if (body === undefined) return
    return Content.parse({
      document: {
        path: rel,
        name: path.basename(rel),
        type,
        task_id: type === "manifest" ? undefined : path.basename(rel, ".md"),
        size: stat.size,
        updated_at: stat.mtimeMs,
      },
      body,
    })
  }

  async function root(sessionID: SessionID, runID: string) {
    if (!segment(sessionID) || !ID.safeParse(runID).success) return
    const dir = await secure(Instance.directory, [".harness", "sessions", sessionID, "runs", runID])
    const stat = dir ? await lstat(dir).catch(() => undefined) : undefined
    if (!stat?.isDirectory()) return
    return dir
  }

  async function target(sessionID: SessionID, runID: string, rel: string) {
    const dir = await root(sessionID, runID)
    if (!dir || !rel || path.posix.isAbsolute(rel) || rel.includes("\\")) return
    const parts = rel.split("/")
    if (parts.some((part) => !part || part === "." || part === "..")) return
    if (!kind(rel)) return
    return secure(dir, parts)
  }

  async function secure(dir: string, parts: string[]) {
    if (parts.some((part) => !segment(part))) return
    const out = parts.reduce((file, part) => path.join(file, part), dir)
    const stats = await Promise.all(
      parts.map((_, index) =>
        lstat(parts.slice(0, index + 1).reduce((file, part) => path.join(file, part), dir)).catch(() => undefined),
      ),
    )
    if (stats.some((stat) => !stat || stat.isSymbolicLink())) return
    return out
  }

  function kind(rel: string): Document["type"] | undefined {
    if (rel === "manifest.md") return "manifest"
    const [type, ...rest] = rel.split("/")
    if (!kinds.includes(type as (typeof kinds)[number]) || rest.length !== 1 || !rel.endsWith(".md")) return
    return type as (typeof kinds)[number]
  }

  function segment(value: string) {
    return ids.test(value) && value !== "." && value !== ".."
  }

  async function content(sessionID: SessionID, runID: string, file: string) {
    const dir = await root(sessionID, runID)
    if (!dir) return
    const project = await realpath(Instance.directory).catch(() => undefined)
    const base = await realpath(dir).catch(() => undefined)
    const target = await realpath(file).catch(() => undefined)
    if (!project || !base || !target) return
    if (base !== path.join(project, ".harness", "sessions", sessionID, "runs", runID)) return
    if (!target.startsWith(base + path.sep)) return

    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
    if (!handle) return
    const body = await (async () => {
      const opened = await handle.stat().catch(() => undefined)
      const expected = await lstat(target).catch(() => undefined)
      const current = await realpath(file).catch(() => undefined)
      const currentBase = await realpath(dir).catch(() => undefined)
      if (!opened?.isFile() || !expected?.isFile()) return
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) return
      if (current !== target || currentBase !== base) return
      return handle.readFile({ encoding: "utf8" })
    })().finally(() => handle.close())
    return body
  }

  async function active(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    const protocol = record(session.dsl_context?.protocol)
    const runs = Array.isArray(protocol.runs) ? protocol.runs : []
    return Promise.all(
      runs.flatMap((item) => {
        const parsed = Active.safeParse(item)
        if (!parsed.success) return []
        return [
          documents(sessionID, parsed.data.runID).then((documents) =>
            Run.parse({
              type: "agent.protocol.result",
              version: "1",
              run_id: parsed.data.runID,
              status: parsed.data.status,
              title: parsed.data.title,
              actions: parsed.data.actions,
              summary: "",
              time: parsed.data.time,
              metrics: parsed.data.metrics,
              documents,
            }),
          ),
        ]
      }),
    )
  }

  function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {}
    return input as Record<string, unknown>
  }
}
