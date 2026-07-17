import path from "path"
import { lstat } from "fs/promises"
import z from "zod"
import { AgentProtocol } from "@/protocol/schema"
import { Storage } from "@/storage/storage"
import { Session } from "."
import { SessionAssignment } from "./assignment"
import { MessageV2 } from "./message-v2"
import { SessionResult } from "./result"
import { SessionID } from "./schema"
import { SessionTurn } from "./turn"
import { Markdown } from "./task-documents"

export namespace SessionRuns {
  const kinds = ["requirements", "designs", "plans", "reviews"] as const
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

  const Source = z.enum(["protocol", "action_result", "fallback_summary"])

  const Delegation = z
    .object({
      type: z.literal("agent.delegation.assignment"),
      run_id: z.string().min(1),
      action_id: z.string().min(1),
      action_title: z.string(),
      parent_session_id: z.string().min(1),
      child_session_id: z.string().min(1),
    })
    .passthrough()

  const Outcome = z
    .object({
      run_id: z.string(),
      summary: z.string().trim().min(1),
      message_id: z.string(),
      completed_at: z.number().nonnegative(),
    })
    .strict()

  export const Run = AgentProtocol.Result.omit({ status: true, summary: true })
    .extend({
      kind: z.enum(["protocol", "delegation"]),
      status: z.enum(["running", "completed", "blocked", "failed"]),
      task: z.string(),
      summary: z.string().optional(),
      summary_source: Source.optional(),
      execution_summary: z.string().optional(),
      action_id: z.string().optional(),
      fallback: z.boolean(),
      documents: z.array(Document).default([]),
    })
    .strict()
  export type Run = z.infer<typeof Run>

  const Projection = z
    .object({
      runID: z.string().min(1),
      status: z.enum(["running", "completed", "blocked", "failed"]),
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
    const session = await Session.get(sessionID)
    const projected = projections(session)
    const delegated = await delegation(session)
    if (!runs.length && !projected.length && !delegated) return []
    const ids = new Set([...runs.map((run) => run.run_id), ...projected.map((run) => run.runID)])
    const outcomes = new Map(
      (await Promise.all([...ids].map(async (id) => [id, await readoutcome(sessionID, id)] as const))).flatMap(
        ([id, outcome]) => (outcome ? ([[id, outcome]] as const) : []),
      ),
    )
    const old = [...ids].some((id) => !outcomes.has(id))
      ? await history(sessionID)
      : new Map<string, { summary: string; source: "protocol" }>()
    const by = new Map(projected.map((run) => [run.runID, run]))
    const saved = await Promise.all(
      runs.map((run) => map(sessionID, run, outcomes.get(run.run_id), by.get(run.run_id), old.get(run.run_id), true)),
    )
    const out = new Map(saved.map((run) => [run.run_id, run]))
    for (const run of projected) {
      if (out.has(run.runID)) continue
      out.set(run.runID, await map(sessionID, projection(run), outcomes.get(run.runID), run, old.get(run.runID)))
    }
    if (delegated) out.set(delegated.run_id, delegated)
    return [...out.values()].sort((a, b) => b.time.started - a.time.started || b.run_id.localeCompare(a.run_id))
  }

  export async function get(sessionID: SessionID, runID: string) {
    if (!ID.safeParse(runID).success) return
    const session = await Session.get(sessionID)
    const delegated = await delegation(session, runID)
    if (delegated?.run_id === runID) return delegated
    const stored = await Storage.read<AgentProtocol.Result>(["session_protocol_run", sessionID, runID]).catch(
      () => undefined,
    )
    const projected = projections(session).find((item) => item.runID === runID)
    if (!stored && !projected) return
    const outcome = await readoutcome(sessionID, runID)
    const old = outcome ? undefined : (await history(sessionID, runID)).get(runID)
    if (stored) return map(sessionID, AgentProtocol.Result.parse(stored), outcome, projected, old, true)
    if (projected) return map(sessionID, projection(projected), outcome, projected, old)
  }

  export async function finish(input: { sessionID: SessionID; runID: string; summary: string; messageID: string }) {
    const summary = Outcome.shape.summary.parse(input.summary)
    const stored = await Storage.read<AgentProtocol.Result>([
      "session_protocol_run",
      input.sessionID,
      input.runID,
    ]).catch(() => undefined)
    const projected = projections(await Session.get(input.sessionID)).some((item) => item.runID === input.runID)
    if (!stored && !projected) throw new Error(`Protocol run not found: ${input.runID}`)
    const key = ["session_protocol_run_outcome", input.sessionID, input.runID]
    const outcome = Outcome.parse({
      run_id: input.runID,
      summary,
      message_id: input.messageID,
      completed_at: Date.now(),
    })
    if (await Storage.create(key, outcome)) return outcome
    const prev = await readoutcome(input.sessionID, input.runID)
    if (prev?.message_id === input.messageID || prev?.summary === summary) return prev
    throw new Error(`Run outcome already exists: ${input.runID}`)
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
        const safe = await Markdown.target(parts(sessionID, runID), rel.split("/"))
        if (!safe) return
        const stat = await lstat(safe.file).catch(() => undefined)
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
    if (!rel || path.posix.isAbsolute(rel) || rel.includes("\\")) return
    const paths = rel.split("/")
    if (paths.some((part) => !part || part === "." || part === "..")) return
    const type = kind(rel)
    if (!type) return
    const body = await Markdown.read(parts(sessionID, runID), paths)
    if (body === undefined) return
    const dir = await root(sessionID, runID)
    if (!dir) return
    const stat = await lstat(path.join(dir, ...paths)).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink()) return
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
    if (!Markdown.segment(sessionID) || !ID.safeParse(runID).success) return
    return Markdown.directory(parts(sessionID, runID))
  }

  function kind(rel: string): Document["type"] | undefined {
    if (rel === "manifest.md") return "manifest"
    const [type, ...rest] = rel.split("/")
    if (!kinds.includes(type as (typeof kinds)[number]) || rest.length !== 1 || !rel.endsWith(".md")) return
    return type as (typeof kinds)[number]
  }

  function parts(sessionID: SessionID, runID: string) {
    return [".harness", "sessions", sessionID, "runs", runID]
  }

  function projections(session: Session.Info) {
    const protocol = record(session.dsl_context?.protocol)
    const runs = Array.isArray(protocol.runs) ? protocol.runs : []
    return runs.flatMap((item) => {
      const parsed = Projection.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  }

  async function delegation(session: Session.Info, runID?: string) {
    if (!session.parentID) return
    const parsed = Delegation.safeParse(record(session.dsl_context?.protocol).delegation)
    if (!parsed.success) return
    const item = parsed.data
    if (item.child_session_id !== session.id || item.parent_session_id !== session.parentID) return
    if (runID && item.run_id !== runID) return
    const assignment = await SessionAssignment.bySource({
      sessionID: session.parentID,
      runID: item.run_id,
      actionID: item.action_id,
    })
    const valid =
      assignment?.session_id === session.id &&
      assignment.source_session_id === session.parentID &&
      assignment.source_run_id === item.run_id &&
      assignment.source_action_id === item.action_id
    const content = valid ? record(await SessionAssignment.content(assignment.id)) : {}
    const plan = typeof content.plan === "string" ? content.plan : item.action_title
    const ref = record(session.dsl_context?.result).result_id
    const direct = typeof ref === "string" ? await SessionResult.parse(ref) : undefined
    const match =
      direct?.parent_session_id === session.parentID &&
      direct.child_session_id === session.id &&
      direct.session_id === session.id &&
      direct.run_id === item.run_id &&
      direct.action_id === item.action_id
    const found = match
      ? direct
      : await SessionResult.find({
          parentSessionID: session.parentID,
          childSessionID: session.id,
          runID: item.run_id,
          actionID: item.action_id,
        }).then((result) => (result ? SessionResult.parse(result.id) : undefined))
    const trusted =
      found?.parent_session_id === session.parentID &&
      found.child_session_id === session.id &&
      found.session_id === session.id &&
      found.run_id === item.run_id &&
      found.action_id === item.action_id
        ? found
        : undefined
    const summary = trusted ? text(summaryof(trusted)) : undefined
    const status = trusted ? runstatus(trusted.status) : "running"
    const completed = trusted?.completed_at ?? trusted?.created_at
    return Run.parse({
      type: "agent.protocol.result",
      version: "1",
      kind: "delegation",
      run_id: item.run_id,
      action_id: item.action_id,
      status,
      title: item.action_title || undefined,
      task: plan,
      summary,
      summary_source: summary ? source(trusted?.carrier) : undefined,
      fallback: trusted?.carrier === "fallback_summary",
      actions: [],
      documents: [],
      time: {
        started: assignment?.time_created ?? trusted?.created_at ?? 0,
        ...(trusted && completed !== undefined ? { completed } : {}),
      },
      metrics: {
        actions: 0,
        internal_tool_calls: 0,
        direct_model_tool_calls: 0,
        model_visible_bytes: 0,
        raw_output_bytes: 0,
        duration_ms: 0,
      },
    })
  }

  function summaryof(result: SessionResult.Parsed) {
    if (result.carrier === "action_result") return result.action_result?.result
    if (result.carrier === "fallback_summary") return result.output ?? result.summary
    if (result.carrier === "agent_protocol_output")
      return result.protocol_result?.message ?? result.protocol_result?.summary ?? result.output ?? result.summary
    return result.output ?? result.summary
  }

  function text(input: unknown) {
    if (typeof input !== "string" || !input.trim()) return
    return input.trim()
  }

  function source(carrier: SessionResult.Carrier | undefined): z.infer<typeof Source> | undefined {
    if (carrier === "action_result") return "action_result"
    if (carrier === "fallback_summary") return "fallback_summary"
    if (carrier === "agent_protocol_output") return "protocol"
  }

  function runstatus(status: SessionResult.Status): Run["status"] {
    if (status === "failed") return "failed"
    if (status === "completed" || status === "partial") return "completed"
    return "blocked"
  }

  function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {}
    return input as Record<string, unknown>
  }

  async function map(
    sessionID: SessionID,
    run: AgentProtocol.Result,
    outcome: z.infer<typeof Outcome> | undefined,
    projected?: z.infer<typeof Projection>,
    old?: { summary: string; source: z.infer<typeof Source> },
    saved = false,
  ) {
    const actions = projected
      ? projected.actions.map((item) => {
          const base = run.actions.find((action) => action.id === item.id)
          if (!base) return item
          return {
            ...item,
            input: base.input,
            depends_on: base.depends_on,
            verification: base.verification,
            sessionID: base.sessionID,
          }
        })
      : run.actions
    return Run.parse({
      ...run,
      kind: "protocol",
      status: saved && projected?.status === "running" ? run.status : (projected?.status ?? run.status),
      actions,
      task: task({ ...run, actions }),
      summary: outcome?.summary ?? old?.summary,
      summary_source: outcome ? "protocol" : old?.source,
      execution_summary: run.summary || undefined,
      fallback: false,
      documents: await documents(sessionID, run.run_id),
    })
  }

  async function history(sessionID: SessionID, target?: string) {
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const assistants = new Map<string, MessageV2.WithParts>()
    messages.forEach((item) => {
      if (item.info.role !== "assistant") return
      assistants.set(item.info.id, item)
    })
    const out = new Map<string, { summary: string; source: "protocol" }>()
    messages.forEach((item) => {
      if (item.info.role !== "user") return
      const turn = SessionTurn.get(item.info)
      if (!turn) return
      const meta = item.info.metadata
      const delegated = meta?.internal === true && meta.source === "delegation" && typeof meta.run_id === "string"
      const run = turn.run_id ?? (delegated ? meta.run_id : undefined)
      if (!run || (target && run !== target) || out.has(run)) return
      const assistant = turn.assistant_id ? assistants.get(turn.assistant_id) : undefined
      if (!assistant || assistant.info.role !== "assistant" || assistant.info.parentID !== item.info.id) return
      const part = assistant.parts.find(
        (part) => part.type === "text" && part.metadata?.kind === "protocol_response" && part.text.trim(),
      )
      if (!part || part.type !== "text") return
      out.set(run, { summary: part.text.trim(), source: "protocol" })
    })
    return out
  }

  async function readoutcome(sessionID: SessionID, runID: string) {
    const value = await Storage.read<unknown>(["session_protocol_run_outcome", sessionID, runID]).catch(
      (err: unknown) => {
        if (Storage.NotFoundError.isInstance(err)) return
        throw err
      },
    )
    if (value === undefined) return
    const outcome = Outcome.parse(value)
    if (outcome.run_id !== runID) throw new Error(`Run outcome mismatch: ${outcome.run_id} !== ${runID}`)
    return outcome
  }

  function projection(run: z.infer<typeof Projection>): AgentProtocol.Result {
    return {
      type: "agent.protocol.result",
      version: "1",
      run_id: run.runID,
      status: run.status === "running" ? "completed" : run.status,
      title: run.title,
      actions: run.actions,
      summary: "",
      time: run.time,
      metrics: run.metrics,
    }
  }

  function task(run: AgentProtocol.Result) {
    return [
      run.title,
      ...run.actions.map((item) => {
        const input = item.input?.prompt ?? item.input?.task ?? item.input?.request
        const body = typeof input === "string" ? input : item.input ? JSON.stringify(item.input, null, 2) : ""
        return [`## ${item.title}`, body].filter(Boolean).join("\n\n")
      }),
    ]
      .filter((item): item is string => Boolean(item))
      .join("\n\n")
  }
}
