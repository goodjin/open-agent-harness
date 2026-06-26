import { Bus } from "@/bus"
import { AgentDelegation } from "@/agent/delegation"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import type { AgentProtocol } from "@/protocol/schema"
import { AgentProtocolExecutor } from "@/protocol/executor"
import { NotFoundError } from "@/storage/db"
import { Log } from "@/util/log"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionLog } from "./log"
import { MessageID, PartID, SessionID } from "./schema"
import { Storage } from "@/storage/storage"
import { ActionResult } from "./action-result"
import { SessionStatus } from "./status"
import { SessionTurn } from "./turn"
import { Provider } from "@/provider/provider"

export namespace SessionDelegation {
  const log = Log.create({ service: "session.delegation" })
  const wait = "The parent session will resume automatically when the child result is available."
  const protocol = "AgentProtocolOutput"
  const state = Instance.state(
    () => ({
      init: false,
      busy: new Set<string>(),
      unsub: undefined as (() => void) | undefined,
    }),
    async (entry) => {
      entry.unsub?.()
    },
  )

  type Status = "completed" | "partial" | "blocked" | "failed" | "waiting_user"
  export type QueryStatus = "pending" | Status
  type SubmitMode = "cancel_without_result" | "terminate_with_result"
  type CloseOpts = {
    mode?: SubmitMode
    reason?: string
  }
  type Row = {
    status: QueryStatus
    run_id: string | undefined
    action_id: string | undefined
    action_title: string | undefined
    parent_agent: string | undefined
    child_session_id: string
    agent: string | undefined
    result_policy: string | undefined
    created_at: number | undefined
    completed_at: number | undefined
    notified_at: number | undefined
    summary: string | undefined
    output?: string
  }
  type Result = ReturnType<typeof completed>
  type Item = {
    type: "agent.delegation.assignment"
    version: "1"
    run_id: string
    action_id: string
    action_title: string
    parent_session_id: string
    parent_message_id: string
    parent_agent?: string
    child_session_id: string
    agent?: string
    metadata?: ReturnType<typeof AgentDelegation.runtime>
    result_policy: string
    result_tool?: string
    created_at: number
    status?: Status
    completed_at?: number
    completed_message_id?: MessageID
    notified_at?: number
    output?: string
    output_ref?: string
    action_result?: ActionResult.Value
    protocol_result?: Protocol
    result_metadata?: ReturnType<typeof AgentDelegation.complete>
    summary?: string
  }
  type Protocol = {
    kind: "answer" | "done" | "success" | "failure" | "error" | "reply"
    id?: string
    message?: string
    summary?: string
    changed_files?: unknown
  }
  type Hit =
    | {
        type: "action"
        message: number
        value: ActionResult.Value
        explicit: boolean
      }
    | {
        type: "protocol"
        message: number
        value: Protocol
      }
  type Diag = {
    raw: string
    status: string
    message: string
    action?: string
  }

  export function init() {
    const ctx = state()
    if (ctx.init) return
    ctx.init = true
    ctx.unsub = Bus.subscribe(MessageV2.Event.Updated, (evt) => {
      void event(evt.properties.info).catch((err) => log.warn("delegation event failed", { err }))
    })
    void recover().catch((err) => log.warn("delegation recovery failed", { err }))
  }

  export async function assign(input: {
    action: AgentProtocol.Action
    agent: string
    childID: SessionID
    metadata?: ReturnType<typeof AgentDelegation.runtime>
    messageID: MessageID
    parentAgent: string
    runID: string
    sessionID: SessionID
  }) {
    const info = await Agent.get(input.agent).catch(() => undefined)
    const item = packet({
      ...input,
      resultTool: info?.runner === "protocol" ? protocol : ActionResult.TOOL,
    })
    const session = await Session.get(input.sessionID)
    const ctx = object(session.dsl_context)
    const prev = object(ctx.protocol)
    const pending = object(prev.pending_delegations)
    await Session.setDslContext({
      sessionID: input.sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          pending_delegations: {
            ...pending,
            [input.childID]: item,
          },
        },
      },
    })

    await Session.setAgent({ sessionID: input.childID, agent: input.agent, confirm: true })
    const child = await Session.get(input.childID)
    const childctx = object(child.dsl_context)
    const childprev = object(childctx.protocol)
    await Session.setDslContext({
      sessionID: input.childID,
      dsl_context: {
        ...childctx,
        protocol: {
          ...childprev,
          delegation: item,
        },
      },
    })
  }

  export async function finish(input: {
    action: AgentProtocol.Action
    agent: string
    childID: SessionID
    messageID: MessageID
    parentAgent: string
    parentID: SessionID
    result: MessageV2.WithParts
    runID: string
  }) {
    const session = await Session.get(input.childID).catch(() => undefined)
    const item = session ? assignment(session) : undefined
    const hold = session && item ? nested(session) : undefined
    if (item && hold) {
      await pause(input.childID, item, hold)
      return false
    }
    const output = input.result.parts.findLast((part) => part.type === "text")?.text ?? ""
    if (output.includes(wait)) {
      await SessionLog.emit({
        sessionID: input.parentID,
        messageID: input.messageID,
        level: "info",
        type: "protocol.agent.waiting",
        data: { actionID: input.action.id, agent: input.agent, childSessionID: input.childID },
      })
      return false
    }
    if (item && (terminal(input.result.parts) || item.result_tool === ActionResult.TOOL)) {
      return complete({
        sessionID: input.childID,
        messageID: input.result.info.id,
      })
    }
    const done = await meta(
      input.agent,
      input.result.info.role === "assistant" && input.result.info.finish === "error" ? "failed" : "completed",
      output,
    )
    return complete({
      sessionID: input.childID,
      messageID: input.result.info.id,
      metadata: done,
      status: done.status,
      output,
    })
  }

  export async function fail(input: {
    action: AgentProtocol.Action
    agent: string
    childID: SessionID
    error: unknown
    messageID: MessageID
    parentAgent: string
    parentID: SessionID
    runID: string
  }) {
    const raw = input.error instanceof Error ? input.error.message : String(input.error)
    const session = await Session.get(input.childID).catch(() => undefined)
    const item = session ? assignment(session) : undefined
    const diag = item?.result_tool === ActionResult.TOOL ? await diagnose(input.childID, raw) : undefined
    const sum =
      item && diag && actionfail(diag.message)
        ? await summarize({
            agent: input.agent,
            diag,
            item,
            sessionID: input.childID,
            status: "failed",
          }).catch((err) => {
            log.warn("fallback summary failed", { err, sessionID: input.childID })
            return undefined
          })
        : undefined
    const output = sum?.output ?? (item && diag ? taskout(item) : raw)
    const done = sum?.metadata ?? (await meta(input.agent, "failed", output))
    return complete({
      sessionID: input.childID,
      messageID: input.messageID,
      metadata: sum?.metadata ?? (diag ? diagnostic(done, diag) : done),
      status: "failed",
      output,
    })
  }

  export async function complete(input: {
    messageID?: MessageID
    metadata?: ReturnType<typeof AgentDelegation.complete>
    output?: string
    sessionID: SessionID
    status?: Status
  }) {
    const ctx = state()
    if (ctx.busy.has(input.sessionID)) return false
    ctx.busy.add(input.sessionID)
    try {
      const session = await Session.get(input.sessionID).catch((err: unknown) => {
        if (err instanceof NotFoundError) return
        throw err
      })
      if (!session) return false
      const item = assignment(session)
      if (!item) return false
      const nest = nested(session)
      if (nest) {
        await pause(input.sessionID, item, nest)
        return false
      }
      const found = input.output === undefined ? await result(input.sessionID, input.messageID, item) : undefined
      if (found?.missing && item.result_tool === ActionResult.TOOL) {
        await remind(input.sessionID, item, found.output)
        return false
      }
      const status = input.status ?? statusof(item) ?? found?.status
      const output = input.output ?? text(item.output) ?? found?.output
      if (!status || output === undefined) return false
      if (output.includes(wait)) return false

      const body = completed(item, status, output, input.metadata ?? item.result_metadata, found?.action, found?.protocol)
      const fresh = statusof(item) !== status || text(item.output) !== output
      const active = await pending(item)
      const done = await delivered(item)
      const message = input.messageID ?? item.completed_message_id
      const load = async () => assignment(await Session.get(input.sessionID))
      const next = await load()
      if (!next) return false
      if (!active && done) {
        if (fresh) await store(input.sessionID, item, body, message)
        await turn(input.sessionID, message, status)
        settle(input.sessionID, status)
        const alreadyNotified = typeof next.notified_at === "number"
        if (alreadyNotified) return false
        await notified(input.sessionID, next)
        return false
      }
      if (fresh) {
        await logdone(body)
        await logmeta(body)
        await store(input.sessionID, item, body, message)
      }
      await turn(input.sessionID, message, status)
      settle(input.sessionID, status)
      const freshNext = await load()
      if (!freshNext) return false
      const routed = await route(body, item)
      if (routed !== "none") {
        await settled(input.sessionID, freshNext)
        if (routed === "notify") return notify(body, item)
        await hold(SessionID.make(item.parent_session_id), item.run_id)
        return true
      }
      await notified(input.sessionID, freshNext)
      return notify(body, item)
    } finally {
      ctx.busy.delete(input.sessionID)
    }
  }

  export async function submit(input: {
    agent?: string
    force?: boolean
    mode?: SubmitMode
    reason?: string
    runID: string
    sessionID: SessionID
  }) {
    const mode = input.mode ?? (input.force === true ? "terminate_with_result" : undefined)
    const ready = await finalize(input.sessionID, input.runID, { mode, reason: input.reason })
    if (ready.waiting > 0) {
      await hold(input.sessionID, input.runID, ready.waiting)
      return false
    }
    const session = await Session.get(input.sessionID)
    if (!(await claim(session, input.runID))) return false
    const { SessionPrompt } = await import("./prompt")
    SessionStatus.set(input.sessionID, { type: "running" })
    void SessionPrompt.prompt({
      sessionID: input.sessionID,
      agent: session.agent ?? input.agent,
      metadata: {
        internal: true,
        source: "delegation",
        run_id: input.runID,
      },
      parts: [
        {
          type: "text",
          text: ready.text,
        },
      ],
    }).catch((error) => {
      log.warn("session delegation submit failed", { error, sessionID: input.sessionID })
    })
    return true
  }

  export async function cancel(input: { reason?: string; runID: string; sessionID: SessionID }) {
    return submit({
      sessionID: input.sessionID,
      runID: input.runID,
      mode: "cancel_without_result",
      reason: input.reason,
    })
  }

  export async function fallbackPreview(input: { sessionID: SessionID }) {
    await Session.get(input.sessionID)
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(input.sessionID)).catch((err: unknown) => {
      if (err instanceof NotFoundError) return []
      throw err
    })
    const msg = msgs.findLast((item) => {
      if (item.info.role !== "assistant") return false
      if (typeof item.info.time.completed !== "number") return false
      return item.parts.some((part) => part.type === "text" && part.text.trim().length > 0)
    })
    if (!msg) return { text: "" }
    return {
      messageID: msg.info.id,
      text: msg.parts
        .flatMap((part) => (part.type === "text" && part.text.trim().length > 0 ? [part.text] : []))
        .join("\n\n")
        .trim(),
    }
  }

  export async function confirmFallback(input: {
    sessionID: SessionID
    status: "success" | "failure" | "reply"
    result: string
    originalMessageID?: MessageID
    edited?: boolean
  }) {
    const session = await Session.get(input.sessionID)
    const item = assignment(session)
    if (!item) return false
    const agent = text(item.agent) ?? session.agent ?? "default"
    const output = [
      "[User-confirmed fallback result]",
      "The delegated child failed to submit native ActionResult after repeated tool-call errors.",
      "The following result was reviewed and confirmed by the user before handoff.",
      "",
      input.result,
    ].join("\n")
    const done = await meta(agent, input.status === "failure" ? "failed" : "completed", output)
    const metadata = {
      ...done,
      source: "user_confirmed_fallback",
      fallback: {
        source: "user_confirmed_fallback",
        original_child_status: SessionStatus.get(input.sessionID).type,
        reason: "action_result_tool_call_failed",
        confirmed_by_user: true,
        original_message_id: input.originalMessageID,
        edited: input.edited === true,
      },
    }
    const ok = await complete({
      sessionID: input.sessionID,
      status: input.status === "failure" ? "failed" : input.status === "reply" ? "partial" : "completed",
      output,
      metadata,
    })
    if (ok) {
      SessionStatus.set(input.sessionID, { type: "user_completed", message: "User confirmed fallback result." })
    }
    return ok
  }

  async function turn(sessionID: SessionID, messageID: MessageID | undefined, status: Status) {
    if (!messageID) return
    const msg = await MessageV2.get({ sessionID, messageID }).catch(() => undefined)
    if (!msg || msg.info.role !== "assistant") return
    const user = await MessageV2.get({ sessionID, messageID: msg.info.parentID }).catch(() => undefined)
    if (!user || user.info.role !== "user") return
    await SessionTurn.finish({
      assistantID: msg.info.id,
      outcome: status === "failed" ? "failed" : status === "blocked" ? "blocked" : "completed",
      reason: "action_result",
      stats: SessionTurn.stats({ message: msg }),
      user: user.info,
    })
  }

  function nested(session: Session.Info) {
    const protocol = object(object(session.dsl_context).protocol)
    const pending = Object.keys(object(protocol.pending_delegations))
    const cycles = Object.keys(object(protocol.verification_cycles))
    if (!pending.length && !cycles.length) return
    return { pending, cycles }
  }

  async function pause(sessionID: SessionID, item: Item, hold: NonNullable<ReturnType<typeof nested>>) {
    await SessionLog.emit({
      sessionID: SessionID.make(item.parent_session_id),
      messageID: MessageID.make(item.parent_message_id),
      level: "info",
      type: "protocol.agent.waiting",
      data: {
        actionID: item.action_id,
        agent: await sessionAgent(sessionID, item.agent),
        childSessionID: sessionID,
        nestedPending: hold.pending,
        verificationCycles: hold.cycles,
      },
    })
  }

  async function remind(sessionID: SessionID, item: Item, output: string | undefined) {
    const { SessionPrompt } = await import("./prompt")
    const res = await ctx(item)
    await SessionPrompt.prompt({
      sessionID,
      agent: text(item.agent) ?? "default",
      parts: [
        {
          type: "text",
          text: [
            `Your delegated task must finish by calling the native ${ActionResult.TOOL} tool.`,
            "Do not return plain text as the final result.",
            "Use result for the task handoff payload: final answer, report, verification conclusion, or next-step request.",
            ...ActionResult.protocol({
              verifier: res.verifier,
              action: item.action_id,
              target: res.target,
            }),
            output ? "" : "",
            output ? "Previous plain-text output:" : "",
            output ?? "",
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
        },
      ],
    })
  }

  export async function recover() {
    for (const session of Session.list({ directory: Instance.directory, limit: 5000 })) {
      if (!assignment(session)) continue
      await complete({ sessionID: session.id })
    }
  }

  export async function query(input: {
    childID?: string
    output?: boolean
    sessionID: SessionID
    status?: QueryStatus
  }) {
    const session = await Session.get(input.sessionID)
    const prev = object(object(session.dsl_context).protocol)
    const pending = (
      await Promise.all(
        Object.entries(object(prev.pending_delegations)).map(([id, item]) =>
          row(item, "pending", input.output === true, id),
        ),
      )
    )
      .filter((item): item is NonNullable<typeof item> => !!item)
      .filter((item) => match(item, input))
    const done = (
      await Promise.all(
        (Array.isArray(prev.completed_delegations) ? prev.completed_delegations : []).map((item) =>
          row(item, "completed", input.output === true),
        ),
      )
    )
      .filter((item): item is NonNullable<typeof item> => !!item)
      .filter((item) => match(item, input))
    return {
      session_id: session.id,
      counts: {
        pending: pending.length,
        completed: done.length,
        total: pending.length + done.length,
      },
      pending,
      completed: done,
    }
  }

  async function event(info: MessageV2.Info) {
    if (info.role !== "assistant") return
    if (typeof info.time.completed !== "number") return
    if (!info.finish || info.finish === "unknown") return
    const session = await Session.get(info.sessionID).catch(() => undefined)
    const item = session ? assignment(session) : undefined
    if (item) {
      if (info.finish !== "tool-calls") return
      const parts = await MessageV2.parts(info.id).catch(() => [])
      if (!terminal(parts)) return
    } else if (info.finish === "tool-calls") {
      return
    }
    await complete({
      sessionID: info.sessionID,
      messageID: info.id,
      status: info.finish === "error" ? "failed" : "completed",
    })
  }

  function packet(input: {
    action: AgentProtocol.Action
    agent: string
    childID: SessionID
    metadata?: ReturnType<typeof AgentDelegation.runtime>
    messageID: MessageID
    parentAgent: string
    resultTool?: string
    runID: string
    sessionID: SessionID
  }): Item {
    return {
      type: "agent.delegation.assignment",
      version: "1",
      run_id: input.runID,
      action_id: input.action.id,
      action_title: input.action.title,
      parent_session_id: input.sessionID,
      parent_message_id: input.messageID,
      parent_agent: input.parentAgent,
      child_session_id: input.childID,
      agent: input.agent,
      metadata: input.metadata,
      result_policy: input.action.result_policy,
      result_tool: input.resultTool ?? ActionResult.TOOL,
      created_at: Date.now(),
    }
  }

  function assignment(session: Session.Info): Item | undefined {
    const item = object(object(session.dsl_context).protocol).delegation
    if (!item || typeof item !== "object" || Array.isArray(item)) return
    const data = object(item)
    if (data.type !== "agent.delegation.assignment") return
    if (
      typeof data.action_id !== "string" ||
      typeof data.action_title !== "string" ||
      typeof data.child_session_id !== "string" ||
      typeof data.parent_message_id !== "string" ||
      typeof data.parent_session_id !== "string" ||
      typeof data.result_policy !== "string" ||
      typeof data.run_id !== "string"
    )
      return
    return data as Item
  }

  async function result(sessionID: SessionID, messageID: MessageID | undefined, item: Item) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID)).catch((err: unknown) => {
      if (err instanceof NotFoundError) return []
      throw err
    })
    const index = messageID ? msgs.findIndex((item) => item.info.id === messageID) : -1
    const scope = index >= 0 ? msgs.slice(0, index + 1) : msgs
    const found = recent(scope)
    if (found?.type === "action") {
      const tail = trailing(scope.slice(found.message + 1))
      const value = await normalize(sessionID, item, found.value)
      const out = found.explicit || !tail ? value : { ...value, result: tail }
      return {
        status: actionStatus(out),
        output: ActionResult.output(out),
        action: out,
      }
    }
    if (found?.type === "protocol") {
      return {
        status: protocolStatus(found.value),
        output: protocolOutput(found.value),
        protocol: found.value,
      }
    }
    const msg = messageID
      ? msgs.find((item) => item.info.id === messageID)
      : msgs.findLast((item) => {
          if (item.info.role !== "assistant") return false
          if (typeof item.info.time.completed !== "number") return false
          if (!item.info.finish || item.info.finish === "tool-calls" || item.info.finish === "unknown") return false
          return true
        })
    if (!msg || msg.info.role !== "assistant") return
    if (typeof msg.info.time.completed !== "number") return
    if (!msg.info.finish || msg.info.finish === "tool-calls" || msg.info.finish === "unknown") return
    if (item.result_tool === ActionResult.TOOL) {
      return {
        status: "blocked" as const,
        output: msg.parts.findLast((part) => part.type === "text")?.text ?? "",
        missing: true,
      }
    }
    if (item.result_tool === protocol) {
      return {
        status: msg.info.finish === "error" ? ("failed" as const) : ("blocked" as const),
        output: msg.parts.findLast((part) => part.type === "text")?.text ?? "",
      }
    }
    if (msg.info.error) {
      const data = "data" in msg.info.error ? msg.info.error.data : undefined
      const err = object(data)
      return {
        status: "failed" as const,
        output: typeof err.message === "string" ? err.message : "Delegated child session failed",
      }
    }
    return {
      status: msg.info.finish === "error" ? ("failed" as const) : ("completed" as const),
      output: msg.parts.findLast((part) => part.type === "text")?.text ?? "",
    }
  }

  function recent(msgs: MessageV2.WithParts[]): Hit | undefined {
    return msgs
      .flatMap((msg, index) => {
        if (msg.info.role !== "assistant") return []
        return msg.parts.flatMap((part): Hit[] => {
          const action = actionPart(part)
          if (action) return [{ ...action, message: index, type: "action" as const }]
          const term = protocolPart(part)
          if (term) return [{ ...term, message: index, type: "protocol" as const }]
          return []
        })
      })
      .findLast(() => true)
  }

  function terminal(parts: MessageV2.Part[]) {
    return actionResult(parts) ?? protocolResult(parts)
  }

  function actionResult(parts: MessageV2.Part[]) {
    return parts
      .flatMap((part) => {
        const found = actionPart(part)
        return found ? [found] : []
      })
      .findLast(() => true)
  }

  function actionPart(part: MessageV2.Part) {
    if (part.type !== "tool" || part.tool !== ActionResult.TOOL || part.state.status !== "completed") return
    const raw = object(part.state.input)
    const parsed = ActionResult.stored(raw)
    if (!parsed.success) return
    return {
      value: parsed.data,
      explicit: typeof raw.result === "string" && raw.result.trim().length > 0,
    }
  }

  function protocolResult(parts: MessageV2.Part[]) {
    return parts
      .flatMap((part) => {
        const found = protocolPart(part)
        return found ? [found] : []
      })
      .findLast(() => true)
  }

  function protocolPart(part: MessageV2.Part) {
    if (part.type !== "tool" || part.tool !== protocol || part.state.status !== "completed") return
    const raw = object(part.state.input)
    const items = Array.isArray(raw.items) ? raw.items.map((item) => object(item)) : []
    const found = items.findLast((item) => {
      return Boolean(kind(item.kind))
    })
    if (!found) return
    const type = kind(found.kind)
    if (!type) return
    return {
      value: {
        kind: type,
        id: text(found.id),
        message: text(found.message),
        summary: text(found.summary),
        changed_files: found.changed_files,
      } as Protocol,
    }
  }

  function kind(input: unknown): Protocol["kind"] | undefined {
    if (input === "answer") return input
    if (input === "done") return input
    if (input === "success") return input
    if (input === "failure") return input
    if (input === "error") return input
    if (input === "reply") return input
  }

  function actionStatus(input: ActionResult.Value): Status {
    if (input.role === "worker") {
      if (input.status === "success") return "completed"
      if (input.status === "reply") return "blocked"
      return "failed"
    }
    if (input.status === "success" || input.status === "skipped") return "completed"
    if (input.status === "failure" || input.status === "reply") return "blocked"
    return "failed"
  }

  function protocolStatus(input: Protocol): Status {
    if (input.kind === "success" || input.kind === "answer" || input.kind === "done") return "completed"
    if (input.kind === "reply") return "blocked"
    return "failed"
  }

  function protocolOutput(input: Protocol) {
    return [
      `AgentProtocolOutput ${input.kind}.`,
      input.id ? `id: ${input.id}` : "",
      input.summary ? `summary: ${input.summary}` : "",
      input.message ? `message: ${input.message}` : "",
      Array.isArray(input.changed_files) && input.changed_files.length
        ? `changed_files: ${input.changed_files.join(", ")}`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n")
  }

  async function normalize(sessionID: SessionID, item: Item, value: ActionResult.Value): Promise<ActionResult.Value> {
    if (value.role !== "verifier") return value
    if (value.action_id !== item.action_id || value.target_action_id !== item.action_id) return value
    const session = await Session.get(sessionID).catch(() => undefined)
    const agent = session?.agent ? await Agent.get(session.agent).catch(() => undefined) : undefined
    if (agent?.kind === "verifier" || session?.agent?.includes("verifier")) return value
    const parsed = ActionResult.worker({
      action_id: value.action_id,
      status: value.status,
      result: value.result,
    })
    return parsed.success ? parsed.data : value
  }

  function trailing(msgs: MessageV2.WithParts[]) {
    return msgs
      .filter((item) => item.info.role === "assistant" && item.info.finish && item.info.finish !== "tool-calls")
      .flatMap((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      .join("\n\n")
      .trim()
  }

  async function latest(sessionID: SessionID) {
    for await (const msg of MessageV2.stream(sessionID)) {
      if (msg.info.role === "user") return msg.info.model
    }
    return Provider.defaultModel()
  }

  async function notice(sessionID: SessionID, item: Item, reason: string | undefined) {
    const session = await Session.get(sessionID)
    const meta = {
      command: {
        source: "parent_session",
        source_session: item.parent_session_id,
        target_session: sessionID,
        intent: "cancel_delegated_task",
        reason,
      },
    }
    const msg = await Session.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: session.agent ?? text(item.agent) ?? "default",
      model: session.model ?? (await latest(sessionID)),
      tools: {},
      mode: "",
      metadata: meta,
    } as MessageV2.User)
    await Session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: msg.id,
      type: "text",
      text: [
        "[Session Command]",
        "source: parent_session",
        `source_session: ${item.parent_session_id}`,
        `target_session: ${sessionID}`,
        "intent: cancel_delegated_task",
        reason ? `reason: ${reason}` : undefined,
        "expected_action: Stop the delegated task. Do not continue work unless the user explicitly resumes this session.",
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n"),
      synthetic: true,
      time: { start: Date.now(), end: Date.now() },
      metadata: meta,
    } as MessageV2.TextPart)
  }

  function completed(
    item: Item,
    status: Status,
    output: string,
    meta?: ReturnType<typeof AgentDelegation.complete>,
    action?: ActionResult.Value,
    term?: Protocol,
  ) {
    return {
      type: "agent.delegation.result",
      version: "1",
      status,
      run_id: item.run_id as string,
      action_id: item.action_id as string,
      action_title: item.action_title as string,
      parent_session_id: item.parent_session_id as string,
      parent_message_id: item.parent_message_id as string,
      child_session_id: item.child_session_id as string,
      metadata: meta,
      result_policy: item.result_policy,
      completed_at: typeof item.completed_at === "number" ? item.completed_at : Date.now(),
      summary: output.slice(0, 4000),
      output,
      ...(action ? { action_result: action } : {}),
      ...(term ? { protocol_result: term } : {}),
    }
  }

  async function store(sessionID: SessionID, item: Item, body: ReturnType<typeof completed>, messageID?: MessageID) {
    const ref = ["session_delegation_result", body.parent_session_id, sessionID].join("/")
    await Storage.write(["session_delegation_result", body.parent_session_id, sessionID], body)
    const brief = slim(body, ref)
    const parent = await Session.get(SessionID.make(item.parent_session_id as string))
    const ctx = object(parent.dsl_context)
    const prev = object(ctx.protocol)
    const done = Array.isArray(prev.completed_delegations) ? prev.completed_delegations : []
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          completed_delegations: [
            ...done.filter((entry) => !object(entry) || entry.child_session_id !== sessionID),
            brief,
          ],
        },
      },
    })

    const child = await Session.get(sessionID)
    const childctx = object(child.dsl_context)
    const childprev = object(childctx.protocol)
    await Session.setDslContext({
      sessionID,
      dsl_context: {
        ...childctx,
        result: {
          type: "session.action_result",
          version: "1",
          status: body.status,
          run_id: body.run_id,
          action_id: body.action_id,
          action_title: body.action_title,
          parent_session_id: body.parent_session_id,
          parent_message_id: body.parent_message_id,
          child_session_id: body.child_session_id,
          result_policy: body.result_policy,
          completed_at: body.completed_at,
          output_ref: ref,
          result_metadata: body.metadata,
          summary: body.summary,
          ...(body.action_result ? { action_result: body.action_result } : {}),
          ...(body.protocol_result ? { protocol_result: body.protocol_result } : {}),
        },
        protocol: {
          ...childprev,
          delegation: {
            ...clean(item),
            status: body.status,
            completed_at: body.completed_at,
            completed_message_id: messageID,
            output_ref: ref,
            result_metadata: body.metadata,
            summary: body.summary,
            ...(body.protocol_result ? { protocol_result: body.protocol_result } : {}),
          },
        },
      },
    })
  }

  function slim(body: ReturnType<typeof completed>, ref: string) {
    return {
      ...Object.fromEntries(Object.entries(body).filter((item) => item[0] !== "output")),
      output_ref: ref,
    }
  }

  async function notify(body: ReturnType<typeof completed>, item: Item) {
    const parentID = SessionID.make(body.parent_session_id as string)
    const started = await resume(parentID, body.run_id, item)
    if (started > 0) {
      await hold(parentID, body.run_id)
      return true
    }
    return submit({ sessionID: parentID, runID: body.run_id, agent: item.parent_agent })
  }

  async function resume(parentID: SessionID, runID: string, item: Item) {
    await close(parentID, runID)
    const parent = await Session.get(parentID)
    const ctx = object(parent.dsl_context)
    const state = object(ctx.protocol)
    const run = (Array.isArray(state.runs) ? state.runs.map((entry) => object(entry)) : []).find(
      (entry) => entry.runID === runID,
    )
    const actions = Array.isArray(run?.actions)
      ? run.actions.map(action).filter((entry): entry is AgentProtocol.Action => Boolean(entry))
      : []
    const refs = new Set(actions.map((entry) => entry.id))
    const active = new Set(
      Object.values(object(state.pending_delegations))
        .map((entry) => object(entry))
        .flatMap((entry) => (typeof entry.action_id === "string" ? [entry.action_id] : [])),
    )
    const done = Array.isArray(state.completed_delegations)
      ? state.completed_delegations.map((entry) => object(entry))
      : []
    const seen = new Set(done.flatMap((entry) => (typeof entry.action_id === "string" ? [entry.action_id] : [])))
    const ids = new Set(
      done.flatMap((entry) => {
        if (satisfying(entry)) return typeof entry.action_id === "string" ? [entry.action_id] : []
        return []
      }),
    )
    const ready = actions.filter((entry) => {
      if (entry.executor.type !== "agent") return false
      if (active.has(entry.id) || seen.has(entry.id)) return false
      return entry.depends_on.every((dep) => !refs.has(dep) || ids.has(dep))
    })
    const result = await Promise.all(
      ready.map((entry) =>
        launch({
          action: entry,
          parent,
          parentAgent: text(item.parent_agent) ?? parent.agent ?? "default",
          messageID: MessageID.make(item.parent_message_id),
          runID,
        }).catch((err) => {
          log.warn("dependent agent launch failed", { err, actionID: entry.id, runID, sessionID: parentID })
          return false
        }),
      ),
    )
    return result.filter(Boolean).length
  }

  function action(input: Record<string, unknown>): AgentProtocol.Action | undefined {
    const executor = object(input.executor)
    const type = text(executor.type)
    const id = text(input.id)
    const title = text(input.title)
    const operation = text(input.operation)
    if (!id || !title || !operation) return
    if (type !== "agent" && type !== "tool" && type !== "runtime" && type !== "human") return
    return {
      type: "action",
      id,
      title,
      description: text(input.description),
      reason: text(input.reason),
      operation,
      executor: {
        type,
        target: text(executor.target) ?? "auto",
        capabilities: Array.isArray(executor.capabilities)
          ? executor.capabilities.filter((entry): entry is string => typeof entry === "string")
          : [],
      },
      input: object(input.input),
      depends_on: Array.isArray(input.depends_on)
        ? input.depends_on.filter((entry): entry is string => typeof entry === "string")
        : [],
      context_refs: Array.isArray(input.context_refs)
        ? input.context_refs.filter((entry): entry is string => typeof entry === "string")
        : [],
      prompt_ref: text(input.prompt_ref),
      verification: object(input.verification) as AgentProtocol.Verification,
      result_policy: policy(text(input.result_policy)),
    }
  }

  function satisfying(input: Record<string, unknown>) {
    const res = object(input.action_result)
    if (res.role === "worker") return res.status === "success"
    if (res.role === "verifier") return res.status === "success" || res.status === "skipped"
    const term = object(input.protocol_result).kind
    return term === "success" || term === "answer" || term === "done"
  }

  async function launch(input: {
    action: AgentProtocol.Action
    parent: Session.Info
    parentAgent: string
    messageID: MessageID
    runID: string
  }) {
    const selected = await select(input.action, input.parentAgent)
    if (!selected) return false
    const meta = await AgentDelegation.meta(selected.name).catch(() => undefined)
    const gate = AgentDelegation.runtime({
      agent: selected.name,
      meta,
      action: input.action,
    })
    await SessionLog.emit({
      sessionID: input.parent.id,
      messageID: input.messageID,
      level: gate.status === "ready" ? "info" : "warn",
      type: "agent.metadata.assignment",
      data: {
        actionID: input.action.id,
        agent: selected.name,
        status: gate.status,
        input: gate.input,
        collaboration: gate.collaboration,
        boundary: gate.boundary,
        snapshot: gate.snapshot,
        observability: gate.observability,
      },
    })
    if (gate.status !== "ready") return false
    const model = selected.model ?? input.parent.model ?? (await latest(input.parent.id))
    const child = await Session.create({
      parentID: input.parent.id,
      title: `Protocol: ${input.action.title.trim()} (@${selected.name})`,
      agent: selected.name,
      model,
      permission: Agent.permissions(selected, input.parent.permission),
    })
    await SessionLog.emit({
      sessionID: input.parent.id,
      messageID: input.messageID,
      level: "info",
      type: "protocol.agent.started",
      data: {
        actionID: input.action.id,
        agent: selected.name,
        childSessionID: child.id,
        snapshot: gate.snapshot,
        observability: gate.observability,
        resumed: true,
      },
    })
    await assign({
      action: input.action,
      agent: selected.name,
      childID: child.id,
      metadata: gate,
      messageID: input.messageID,
      parentAgent: input.parentAgent,
      runID: input.runID,
      sessionID: input.parent.id,
    })
    const { SessionPrompt } = await import("./prompt")
    setTimeout(() => {
      SessionPrompt.resolvePromptParts(task(input.action, selected))
        .then((parts) =>
          SessionPrompt.prompt({
            sessionID: child.id,
            agent: selected.name,
            model,
            parts,
          }),
        )
        .then((msg) =>
          finish({
            action: input.action,
            agent: selected.name,
            childID: child.id,
            messageID: input.messageID,
            parentAgent: input.parentAgent,
            parentID: input.parent.id,
            result: msg,
            runID: input.runID,
          }),
        )
        .catch((err) =>
          fail({
            action: input.action,
            agent: selected.name,
            childID: child.id,
            messageID: input.messageID,
            parentAgent: input.parentAgent,
            parentID: input.parent.id,
            runID: input.runID,
            error: err,
          }),
        )
    }, 0)
    return true
  }

  async function select(action: AgentProtocol.Action, parent: string) {
    const agents = AgentDelegation.list(await Agent.list(), parent)
    const found =
      action.executor.target === "auto"
        ? AgentProtocolExecutor.select(
            action,
            agents.map((entry) => ({
              id: entry.name,
              entry: entry.entry,
              capability: entry.capability,
            })),
          )?.id
        : agents.find((entry) => entry.name === action.executor.target)?.name
    if (!found) return
    const selected = await Agent.get(found).catch(() => undefined)
    if (!selected) return
    if (AgentDelegation.visible(selected, parent)) return selected
  }

  function task(action: AgentProtocol.Action, agent: Agent.Info) {
    if (agent.runner === "protocol") {
      return [
        `Please handle this delegated planner task: ${action.title}.`,
        "Treat the task block below as your initial task for this session.",
        "When the task is complete, return a terminal AgentProtocolOutput item: success, failure, error, or reply.",
        "Use success only when this delegated action is satisfied and downstream depends_on actions may run.",
        "Use failure, error, or reply when the action is terminal but not satisfied.",
        "",
        "<task>",
        brief(action),
        "</task>",
      ].join("\n")
    }
    return [
      `Please handle this delegated task: ${action.title}.`,
      "Treat the task block below as your initial task for this session.",
      "When you are done, return a task result for the parent session.",
      "Use result for the task handoff payload: final answer, report, verification conclusion, or next-step request.",
      "Use one result status: success, failure, error, reply, or skipped.",
      "For success/failure/error, include result, changed_files, verification, and blockers.",
      ...ActionResult.protocol({
        verifier: agent.kind === "verifier",
        action: action.id,
        target: action.depends_on[0] ?? "worker_action_id",
      }),
      "Use reply when you need to answer or ask for information instead of claiming the task is complete.",
      policyText(action.result_policy),
      "",
      "<task>",
      brief(action),
      "</task>",
    ].join("\n")
  }

  function policy(input: unknown): AgentProtocol.Action["result_policy"] {
    if (input === "summary") return input
    if (input === "structured") return input
    if (input === "full") return input
    if (input === "on_failure") return input
    if (input === "on_demand") return input
    if (input === "adaptive") return input
    return "summary"
  }

  function policyText(input: AgentProtocol.Action["result_policy"]) {
    if (input === "summary") return "Keep the result concise and focused on the outcome."
    if (input === "structured") return "Use a structured result with clear sections or bullets."
    if (input === "full") return "Include the full relevant details needed by the parent session."
    if (input === "on_failure")
      return "Keep the result brief unless the task fails; if it fails, include the failure details and next step."
    if (input === "on_demand") return "Keep the result brief and mention where more detail is available if needed."
    return "Adapt the level of detail to the task complexity and risk."
  }

  async function claim(parent: Session.Info, runID: string) {
    const ctx = object(parent.dsl_context)
    const protocol = object(ctx.protocol)
    const sent = object(protocol.delegation_notified_runs)
    if (typeof sent[runID] === "number") return false
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...ctx,
        protocol: {
          ...protocol,
          delegation_notified_runs: {
            ...sent,
            [runID]: Date.now(),
          },
        },
      },
    })
    return true
  }

  async function hold(parentID: SessionID, runID: string, count?: number) {
    const ready = count ?? (await finalize(parentID, runID)).waiting
    if (ready <= 0) return
    SessionStatus.set(parentID, {
      type: "waiting_child",
      message: `Waiting for ${ready} delegated child session${ready === 1 ? "" : "s"}.`,
    })
  }

  async function finalize(parentID: SessionID, runID: string, opts?: CloseOpts) {
    await close(parentID, runID, opts)
    const parent = await Session.get(parentID)
    const protocol = object(object(parent.dsl_context).protocol)
    const pending = Object.entries(object(protocol.pending_delegations))
      .map(([id, item]) => ({ id, item: object(item) }))
      .filter((entry) => entry.item.run_id === runID)
    const done = await Promise.all(
      (Array.isArray(protocol.completed_delegations) ? protocol.completed_delegations : [])
        .map((entry) => object(entry))
        .filter((entry) => entry.run_id === runID)
        .map((entry) => row(entry, "completed", true)),
    )
    const rows = done.filter((entry): entry is Row => !!entry)
    return {
      waiting: pending.length,
      text: markdown(runID, rows),
    }
  }

  async function close(parentID: SessionID, runID: string, opts?: CloseOpts) {
    const parent = await Session.get(parentID)
    const protocol = object(object(parent.dsl_context).protocol)
    const mode = opts?.mode
    const entries = Object.entries(object(protocol.pending_delegations))
      .map(([id, item]) => ({ id: SessionID.make(id), item: object(item) as Item }))
      .filter((entry) => entry.item.run_id === runID && (mode !== undefined || ended(SessionStatus.get(entry.id))))
    for (const entry of entries) {
      if (await delivered(entry.item)) {
        await notified(entry.id, entry.item)
        continue
      }
      const status = SessionStatus.get(entry.id)
      if (mode === "cancel_without_result") {
        const { SessionPrompt } = await import("./prompt")
        const reason = opts?.reason ?? "User cancelled delegated child session without collecting a result."
        await notice(entry.id, entry.item, reason)
        SessionPrompt.cancel(entry.id)
        SessionStatus.set(entry.id, { type: "aborted", message: reason }, { reason })
        const body = completed(
          entry.item,
          "failed",
          [
            "Delegated child session was cancelled by the user.",
            "No child result was requested or collected.",
            "The parent summary should continue without this child result.",
          ].join("\n"),
          undefined,
          undefined,
        )
        await logdone(body)
        await store(entry.id, entry.item, body)
        await notified(entry.id, entry.item)
        continue
      }
      const out = [
        `Delegated child session ended with status ${status.type}.`,
        "No structured child result was recorded before the session ended.",
        "The parent summary should treat this child as ended and mention the status explicitly.",
        mode === "terminate_with_result" && !ended(status)
          ? "This result was submitted manually before the child session reached a terminal state."
          : "",
        "message" in status && typeof status.message === "string" ? status.message : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n")
      if (mode === "terminate_with_result") {
        const found = status.type === "completed" ? await existing(entry.id, entry.item) : undefined
        if (found) {
          await logdone(found)
          await store(entry.id, entry.item, found)
          await notified(entry.id, entry.item)
          continue
        }
        if (status.type !== "completed") {
          const { SessionPrompt } = await import("./prompt")
          SessionPrompt.cancel(entry.id)
          SessionStatus.set(
            entry.id,
            { type: "user_completed", message: "Terminated by user after collecting current result." },
            { reason: "User terminated delegated child session and collected current result." },
          )
        }
      }
      const sum =
        mode === "terminate_with_result"
          ? await summarize({
              agent: text(entry.item.agent) ?? "default",
              item: entry.item,
              sessionID: entry.id,
              status: "partial",
            }).catch((err) => {
              log.warn("termination summary failed", { err, sessionID: entry.id })
              return undefined
            })
          : entry.item.result_tool === ActionResult.TOOL && actionfail(out)
          ? await summarize({
              agent: text(entry.item.agent) ?? "default",
              diag: await diagnose(entry.id, out),
              item: entry.item,
              sessionID: entry.id,
              status: fallback(status),
            }).catch((err) => {
              log.warn("fallback summary failed", { err, sessionID: entry.id })
              return undefined
            })
          : undefined
      const body = completed(
        entry.item,
        sum?.status ?? (mode === "terminate_with_result" ? "partial" : map(status)),
        sum?.output ?? out,
        sum?.metadata,
        undefined,
      )
      await logdone(body)
      await store(entry.id, entry.item, body)
      await notified(entry.id, entry.item)
    }
  }

  async function existing(sessionID: SessionID, item: Item): Promise<Result | undefined> {
    const stored = await Storage.read<unknown>(["session_delegation_result", item.parent_session_id, sessionID]).catch(
      () => undefined,
    )
    const direct = restore(stored, item)
    if (direct) return direct

    const parent = await Session.get(SessionID.make(item.parent_session_id)).catch(() => undefined)
    const prev = object(object(parent?.dsl_context).protocol)
    const done = Array.isArray(prev.completed_delegations) ? prev.completed_delegations.map((entry) => object(entry)) : []
    const row = done.find((entry) => entry.child_session_id === sessionID && entry.run_id === item.run_id)
    const ref = text(row?.output_ref)
    const full = ref ? await Storage.read<unknown>(ref.split("/")).catch(() => undefined) : undefined
    const saved = restore(full, item) ?? restore(row, item)
    if (saved) return saved

    const child = await Session.get(sessionID).catch(() => undefined)
    const ctx = restore(object(child?.dsl_context).result, item)
    if (ctx) return ctx

    const parsed = await result(sessionID, item.completed_message_id, item)
    if (!parsed) return
    if (!("action" in parsed) && !("protocol" in parsed)) return
    const agent = text(item.agent) ?? "default"
    return completed(
      item,
      parsed.status,
      parsed.output,
      await meta(agent, parsed.status === "completed" ? "completed" : "failed", parsed.output),
      "action" in parsed ? parsed.action : undefined,
      "protocol" in parsed ? parsed.protocol : undefined,
    )
  }

  function restore(input: unknown, item: Item): Result | undefined {
    const data = object(input)
    if (data.type !== "agent.delegation.result" && data.type !== "session.action_result") return
    const status = statusof(data)
    const output = text(data.output) ?? text(data.summary)
    if (!status || !output) return
    const next = {
      ...item,
      completed_at: number(data.completed_at) ?? item.completed_at,
    }
    const meta = data.metadata || data.result_metadata
    const action = object(data.action_result)
    const term = object(data.protocol_result)
    return completed(
      next,
      status,
      output,
      meta ? (object(meta) as ReturnType<typeof AgentDelegation.complete>) : undefined,
      Object.keys(action).length > 0 ? (action as ActionResult.Value) : undefined,
      Object.keys(term).length > 0 ? (term as Protocol) : undefined,
    )
  }

  function ended(status: SessionStatus.Info) {
    return (
      status.type === "completed" ||
      status.type === "user_completed" ||
      status.type === "aborted" ||
      status.type === "failed" ||
      status.type === "blocked" ||
      status.type === "interrupted" ||
      status.type === "timeout" ||
      status.type === "error" ||
      status.type === "archived"
    )
  }

  function map(status: SessionStatus.Info): Status {
    if (status.type === "completed") return "completed"
    if (status.type === "user_completed") return "partial"
    if (status.type === "blocked") return "blocked"
    return "failed"
  }

  function fallback(status: SessionStatus.Info): Status {
    if (status.type === "blocked" || status.type === "user_completed") return "partial"
    return map(status)
  }

  async function summarize(input: {
    agent: string
    diag?: Diag
    item: Item
    sessionID: SessionID
    status: Status
  }) {
    const { SessionPrompt } = await import("./prompt")
    const child = await Session.get(input.sessionID)
    const session = await Session.create({
      parentID: input.sessionID,
      title: `Fallback summary: ${input.item.action_title}`,
      agent: "summary",
      model: child.model,
    })
    const msg = await SessionPrompt.prompt({
      sessionID: session.id,
      agent: "summary",
      model: child.model,
      metadata: {
        internal: true,
        source: "delegation_fallback_summary",
        run_id: input.item.run_id,
        child_session_id: input.sessionID,
      },
      parts: [
        {
          type: "text",
          text: [
            "Summarize this delegated child session for its parent handoff.",
            "Return plain Markdown text only. Do not call tools.",
            "Produce a concise task-result summary only.",
            "Include the original delegated requirement, final result and produced artifacts, verification evidence or confidence level, important findings for continuation, and remaining blockers, risks, or next steps.",
            "Do not include execution process details.",
            "Do not include protocol, tool-call, ActionResult, or handoff failure details.",
            "If evidence is missing, say what result can be inferred from the transcript and what remains unverified.",
            "",
            "## Assignment",
            `- Action: ${input.item.action_id}`,
            `- Title: ${input.item.action_title}`,
            `- Agent: ${text(input.item.agent) ?? input.agent}`,
            `- Child session: ${input.sessionID}`,
            `- Runtime status: ${input.status}`,
            "",
            "## Child Transcript",
            await transcript(input.sessionID),
          ].join("\n"),
        },
      ],
    })
    const output =
      text(msg.parts.findLast((part) => part.type === "text")?.text)?.trim() ??
      "No task-result summary could be recovered from the child transcript."
    return {
      status: input.status,
      output,
      metadata: {
        ...(await meta(input.agent, input.status === "completed" ? "completed" : "failed", output)),
        source: "fallback_summary",
        fallback: {
          source: "fallback_summary",
          reason: "action_result_tool_call_failed",
          original_child_status: SessionStatus.get(input.sessionID).type,
          summary_session_id: session.id,
          confirmed_by_user: false,
          diagnostic: input.diag,
        },
      },
    }
  }

  async function transcript(sessionID: SessionID) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    const out = msgs
      .flatMap((msg) => {
        const head = [`[${msg.info.role}${msg.info.role === "assistant" ? ` finish=${msg.info.finish ?? "unknown"}` : ""}]`]
        const parts = msg.parts.flatMap((part) => {
          if (part.type === "text") return [part.text]
          return []
        })
        return parts.length ? [[...head, ...parts].join("\n")] : []
      })
      .join("\n\n")
      .trim()
    if (!out) return "No assistant text or ActionResult evidence was recorded."
    return out.length > 12000 ? out.slice(out.length - 12000) : out
  }

  function actionfail(input: string) {
    return /ActionResult|action_result/i.test(input)
  }

  async function diagnose(sessionID: SessionID, raw: string): Promise<Diag> {
    const status = SessionStatus.get(sessionID)
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID)).catch((err: unknown) => {
      if (err instanceof NotFoundError) return []
      throw err
    })
    const part = msgs
      .flatMap((msg) => msg.parts)
      .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === ActionResult.TOOL)
      .findLast((part) => part.state.status === "error")
    const action = part?.state.status === "error" ? part.state.error : undefined
    return {
      raw,
      status: status.type,
      action,
      message: [
        "ActionResult handoff failed.",
        "message" in status && typeof status.message === "string" ? status.message : undefined,
        action,
        raw && raw !== action ? `Wrapper error: ${raw}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    }
  }

  function diagnostic(done: ReturnType<typeof AgentDelegation.complete>, diag: Diag) {
    return {
      ...done,
      source: "fallback_summary",
      fallback: {
        source: "fallback_summary",
        reason: "action_result_tool_call_failed",
        original_child_status: diag.status,
        confirmed_by_user: false,
        diagnostic: diag,
      },
    }
  }

  function taskout(item: Item) {
    return [
      "## Task Result",
      `Original task: ${item.action_title}`,
      "Result: unavailable from the child transcript.",
      "Next step: inspect the child session artifacts and transcript before continuing.",
    ].join("\n")
  }

  function markdown(runID: string, rows: Row[]) {
    const count = (status: QueryStatus) => rows.filter((row) => row.status === status).length
    return [
      `Delegated child sessions have finished for run \`${runID}\`. Continue the parent task using the collected results.`,
      "",
      "## Run Status",
      `- Child sessions: ${rows.length}`,
      `- Completed: ${count("completed")}`,
      `- Partial: ${count("partial")}`,
      `- Blocked: ${count("blocked")}`,
      `- Failed: ${count("failed")}`,
      "",
      "## Child Results",
      ...rows
        .flatMap((row, index) => [
          "",
          `### ${index + 1}. ${row.action_title ?? row.action_id ?? row.child_session_id}`,
          row.action_id ? `- Action: \`${row.action_id}\`` : "",
          row.agent ? `- Agent: @${row.agent}` : "",
          `- Child session: \`${row.child_session_id}\``,
          `- Status: ${row.status}`,
          row.summary ? `- Summary: ${row.summary}` : "- Summary: No summary was recorded.",
        ])
        .filter((line) => line.length > 0),
      "",
      "If these results complete the requested work, reply to the user in Markdown with the final outcome. If more work is needed, produce the next protocol package.",
    ].join("\n")
  }

  async function route(body: ReturnType<typeof completed>, item: Item) {
    const res = body.action_result
    if (!res) return "none" as const
    if (res.role === "worker") return worker(body, item, res)
    return verifier(body, item, res)
  }

  async function worker(body: ReturnType<typeof completed>, item: Item, res: ActionResult.Value & { role: "worker" }) {
    if (res.status !== "success") return "none" as const
    const gates = await checks(item, res.action_id)
    if (gates.length === 0) return "none" as const
    const next = await ready(item, gates)
    if (next) {
      await start(item, body, next)
      return "wait" as const
    }
    if (res.scope === "verification_feedback") {
      await summary(item, body)
      return "wait" as const
    }
    await verified(item, body, gates)
    return "notify" as const
  }

  async function verifier(
    body: ReturnType<typeof completed>,
    item: Item,
    res: ActionResult.Value & { role: "verifier" },
  ) {
    const worker = await workerrow(item, res.target_action_id)
    if (!worker) return "none" as const
    if (res.status === "failure" || res.status === "reply") {
      const count = await cycle(item, res.target_action_id)
      if (count >= 2) {
        await verified(
          worker.item,
          await aggregate(worker.item, worker.body, "blocked"),
          await checks(worker.item, res.target_action_id),
        )
        await reset(item, res.target_action_id)
        return "notify" as const
      }
      await fix(worker.item, res, count)
      return "wait" as const
    }
    if (res.status === "error") {
      await verified(
        worker.item,
        await aggregate(worker.item, worker.body, "blocked"),
        await checks(worker.item, res.target_action_id),
      )
      await reset(item, res.target_action_id)
      return "notify" as const
    }
    const gates = await checks(worker.item, res.target_action_id)
    const next = await ready(worker.item, gates)
    if (next) {
      await start(worker.item, worker.body, next)
      return "wait" as const
    }
    const workerResult = worker.body.action_result
    if (workerResult?.role === "worker" && workerResult.scope === "verification_feedback") {
      await summary(worker.item, worker.body)
      return "wait" as const
    }
    await verified(worker.item, await aggregate(worker.item, worker.body, "completed"), gates)
    await reset(item, res.target_action_id)
    return "notify" as const
  }

  async function checks(item: Item, worker: string) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const protocol = object(object(parent.dsl_context).protocol)
    const runs = Array.isArray(protocol.runs) ? protocol.runs.map((run) => object(run)) : []
    const run = runs.find((run) => run.runID === item.run_id)
    const actions = Array.isArray(run?.actions) ? run.actions.map((action) => object(action)) : []
    const found = await Promise.all(
      actions
        .filter((action) => object(action.executor).type === "agent")
        .map(async (action) => {
          const verification = object(action.verification)
          if (verification.worker === worker) return action
          if (!Array.isArray(action.depends_on) || !action.depends_on.includes(worker)) return
          if (verification.role === "test" || verification.role === "review") return action
          const target = text(object(action.executor).target)
          if (!target) return
          const agent = await Agent.get(target).catch(() => undefined)
          if (agent?.kind === "verifier") return action
        }),
    )
    return found.filter((action): action is AgentProtocol.Action => Boolean(action))
  }

  async function ready(item: Item, gates: AgentProtocol.Action[]) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const protocol = object(object(parent.dsl_context).protocol)
    const pending = Object.values(object(protocol.pending_delegations)).map((entry) => object(entry))
    const done = Array.isArray(protocol.completed_delegations)
      ? protocol.completed_delegations.map((entry) => object(entry))
      : []
    const passed = new Set(
      done.flatMap((entry) => {
        const res = object(entry.action_result)
        if (res.role !== "verifier") return []
        if (res.status !== "success" && res.status !== "skipped") return []
        return typeof res.action_id === "string" ? [res.action_id] : []
      }),
    )
    const active = new Set(pending.flatMap((entry) => (typeof entry.action_id === "string" ? [entry.action_id] : [])))
    return gates.find((gate) => !passed.has(gate.id) && !active.has(gate.id))
  }

  async function start(item: Item, body: ReturnType<typeof completed>, gate: AgentProtocol.Action) {
    const { SessionPrompt } = await import("./prompt")
    const child = await Session.create({
      parentID: SessionID.make(item.child_session_id),
      title: `Verifier: ${gate.title} (@${gate.executor.target})`,
      agent: gate.executor.target,
    })
    await assign({
      action: gate,
      agent: gate.executor.target,
      childID: child.id,
      messageID: MessageID.make(item.parent_message_id),
      parentAgent: text(item.parent_agent) ?? "default",
      runID: item.run_id,
      sessionID: SessionID.make(item.parent_session_id),
    })
    await SessionPrompt.prompt({
      sessionID: child.id,
      agent: gate.executor.target,
      parts: [
        {
          type: "text",
          text: [
            `Run verifier action ${gate.id}: ${gate.title}.`,
            "Call ActionResult exactly once when finished.",
            "Set target_action_id to the worker action id. Use status success, failure, error, reply, or skipped.",
            "Keep issues, evidence, and worker_feedback as short strings. Do not use arrays or nested objects.",
            "",
            "## Verifier Prompt",
            brief(gate),
            "",
            "## Worker Result",
            body.output,
          ].join("\n"),
        },
      ],
    })
  }

  function brief(action: AgentProtocol.Action) {
    const input = object(action.input)
    return text(input.prompt) ?? text(action.description) ?? text(action.reason) ?? action.title
  }

  async function workerrow(item: Item, worker: string) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const done = Array.isArray(object(object(parent.dsl_context).protocol).completed_delegations)
      ? (object(object(parent.dsl_context).protocol).completed_delegations as unknown[]).map((entry) => object(entry))
      : []
    const row = done.find((entry) => entry.action_id === worker && object(entry.action_result).role === "worker")
    if (!row) return
    return {
      item: row as Item,
      body: {
        ...row,
        output: (await full(row)) ?? text(row.output) ?? text(row.summary) ?? "",
      } as ReturnType<typeof completed>,
    }
  }

  async function aggregate(item: Item, body: ReturnType<typeof completed>, status: Status) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const protocol = object(object(parent.dsl_context).protocol)
    const done = Array.isArray(protocol.completed_delegations)
      ? protocol.completed_delegations.map((entry) => object(entry))
      : []
    const res = object(body.action_result)
    const worker = typeof res.action_id === "string" ? res.action_id : item.action_id
    const attempts = number(object(protocol.verification_cycles)[worker]) ?? 0
    const checks = done.filter((entry) => {
      const out = object(entry.action_result)
      return out.role === "verifier" && out.target_action_id === worker
    })
    const text = [
      body.output,
      "",
      "Verification results:",
      attempts > 0 ? `Verification loop attempts: ${attempts}` : "",
      ...checks.map((entry) => {
        const out = object(entry.action_result)
        return `- ${entry.action_id}: ${out.status ?? "unknown"} - ${out.result ?? entry.summary ?? ""}`
      }),
    ]
      .filter((line) => line.length > 0)
      .join("\n")
    return {
      ...body,
      status,
      summary: text.slice(0, 4000),
      output: text,
      verification_results: checks,
    }
  }

  async function verified(item: Item, body: ReturnType<typeof completed>, gates: AgentProtocol.Action[]) {
    await store(SessionID.make(item.child_session_id), item, body)
    await notified(SessionID.make(item.child_session_id), item)
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const ctx = object(parent.dsl_context)
    const protocol = object(ctx.protocol)
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...ctx,
        protocol: {
          ...protocol,
          verification_cycles: prune(protocol.verification_cycles, item.action_id),
          verification_completed: [
            ...(Array.isArray(protocol.verification_completed) ? protocol.verification_completed : []),
            {
              action_id: item.action_id,
              gates: gates.map((gate) => gate.id),
              completed_at: Date.now(),
            },
          ],
        },
      },
    })
  }

  async function fix(item: Item, res: ActionResult.Value & { role: "verifier" }, count: number) {
    const { SessionPrompt } = await import("./prompt")
    await SessionPrompt.prompt({
      sessionID: SessionID.make(item.child_session_id),
      agent: text(item.agent) ?? "default",
      parts: [
        {
          type: "text",
          text: [
            `Verifier ${res.action_id} did not pass on attempt ${count}.`,
            res.worker_feedback ?? res.result,
            "",
            "Fix the issue, then call ActionResult with status `success`, scope `verification_feedback`, result, and concise string fields.",
          ].join("\n"),
        },
      ],
    })
  }

  async function summary(item: Item, body: ReturnType<typeof completed>) {
    const { SessionPrompt } = await import("./prompt")
    await SessionPrompt.prompt({
      sessionID: SessionID.make(item.child_session_id),
      agent: text(item.agent) ?? "default",
      parts: [
        {
          type: "text",
          text: [
            "The verifier feedback loop has passed, but your latest worker result only described verification feedback.",
            "Return a complete task summary for the original delegated task.",
            "Call ActionResult with status `success`, scope `final_summary`, and include result, changed_files, verification, and blockers as short strings.",
            "",
            "Latest worker result:",
            body.output,
          ].join("\n"),
        },
      ],
    })
  }

  async function cycle(item: Item, worker: string) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const ctx = object(parent.dsl_context)
    const protocol = object(ctx.protocol)
    const cycles = object(protocol.verification_cycles)
    const count = number(cycles[worker]) ?? 0
    const next = count + 1
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...ctx,
        protocol: {
          ...protocol,
          verification_cycles: {
            ...cycles,
            [worker]: next,
          },
        },
      },
    })
    return next
  }

  async function reset(item: Item, worker: string) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const ctx = object(parent.dsl_context)
    const protocol = object(ctx.protocol)
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...ctx,
        protocol: {
          ...protocol,
          verification_cycles: prune(protocol.verification_cycles, worker),
        },
      },
    })
  }

  function prune(input: unknown, worker: string) {
    const cycles = { ...object(input) }
    delete cycles[worker]
    return cycles
  }

  async function settled(sessionID: SessionID, item: Item) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const pctx = object(parent.dsl_context)
    const pprev = object(pctx.protocol)
    const pend = { ...object(pprev.pending_delegations) }
    delete pend[sessionID]
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...pctx,
        protocol: {
          ...pprev,
          pending_delegations: pend,
        },
      },
    })
  }

  async function progress(body: ReturnType<typeof completed>) {
    const parent = await Session.get(SessionID.make(body.parent_session_id as string))
    const prev = object(object(parent.dsl_context).protocol)
    const pend = Object.keys(object(prev.pending_delegations)).filter((item) => item !== body.child_session_id)
    const done = Array.isArray(prev.completed_delegations)
      ? prev.completed_delegations
          .map((item) => object(item))
          .filter((item) => typeof item.child_session_id === "string")
      : []
    const ids = new Set([...done.map((item) => item.child_session_id as string), ...pend])
    const idx = done.findIndex((item) => item.child_session_id === body.child_session_id)
    return {
      total: ids.size || 1,
      index: idx >= 0 ? idx + 1 : done.length + 1,
      running: pend.length,
    }
  }

  async function pending(item: Item) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const prev = object(object(parent.dsl_context).protocol)
    return object(prev.pending_delegations)[item.child_session_id] !== undefined
  }

  async function delivered(item: Item) {
    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const prev = object(object(parent.dsl_context).protocol)
    return (
      Array.isArray(prev.completed_delegations) &&
      prev.completed_delegations.some((entry) => object(entry).child_session_id === item.child_session_id)
    )
  }

  async function notified(sessionID: SessionID, item: Item) {
    const child = await Session.get(sessionID)
    const ctx = object(child.dsl_context)
    const prev = object(ctx.protocol)
    const time = Date.now()
    await Session.setDslContext({
      sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          delegation: {
            ...clean(item),
            notified_at: time,
          },
        },
      },
    })

    const parent = await Session.get(SessionID.make(item.parent_session_id))
    const pctx = object(parent.dsl_context)
    const pprev = object(pctx.protocol)
    const pend = { ...object(pprev.pending_delegations) }
    delete pend[sessionID]
    const done = Array.isArray(pprev.completed_delegations) ? pprev.completed_delegations : []
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...pctx,
        protocol: {
          ...pprev,
          pending_delegations: pend,
          completed_delegations: done.map((entry) => {
            const data = object(entry)
            if (data.child_session_id !== sessionID) return entry
            return {
              ...clean(data),
              notified_at: time,
            }
          }),
        },
      },
    })
  }

  async function logdone(body: ReturnType<typeof completed>) {
    const agent = await sessionAgent(body.child_session_id)
    await SessionLog.emit({
      sessionID: SessionID.make(body.parent_session_id as string),
      messageID: MessageID.make(body.parent_message_id as string),
      level: body.status === "failed" ? "warn" : "info",
      type: body.status === "failed" ? "protocol.agent.failed" : "protocol.agent.completed",
      data: {
        actionID: body.action_id,
        ...(agent ? { agent } : {}),
        childSessionID: body.child_session_id,
        outputBytes: typeof body.output === "string" ? body.output.length : 0,
      },
    })
  }

  async function logmeta(body: ReturnType<typeof completed>) {
    if (!body.metadata) return
    const agent = await sessionAgent(body.child_session_id)
    await SessionLog.emit({
      sessionID: SessionID.make(body.parent_session_id),
      messageID: MessageID.make(body.parent_message_id),
      level: body.metadata.status === "completed" ? "info" : "warn",
      type:
        body.metadata.validation.status === "valid"
          ? "agent.metadata.output_validated"
          : "agent.metadata.output_validation_failed",
      data: {
        ...(agent ? { agent } : {}),
        status: body.metadata.status,
        artifacts: body.metadata.artifacts,
        validation: body.metadata.validation,
        completion: body.metadata.completion,
      },
    })
    if (body.metadata.status === "completed") return
    if (!agent) return
    const cfg = await AgentDelegation.meta(agent).catch(() => undefined)
    const msgs = AgentDelegation.messages({ meta: cfg, event: "output_validation_failed" })
    if (!msgs.records.length && !msgs.diagnostics.length) return
    await SessionLog.emit({
      sessionID: SessionID.make(body.parent_session_id),
      messageID: MessageID.make(body.parent_message_id),
      level: "warn",
      type: "agent.metadata.messages",
      data: {
        agent,
        event: "output_validation_failed",
        records: msgs.records,
        diagnostics: msgs.diagnostics,
      },
    })
  }

  async function row(
    input: unknown,
    fallback: QueryStatus,
    output: boolean,
    childID?: string,
  ): Promise<Row | undefined> {
    const item = object(input)
    const child = text(item.child_session_id) ?? childID
    if (!child) return
    const out = text(item.output) ?? (output ? await full(item) : undefined)
    return {
      status: statusof(item) ?? fallback,
      run_id: text(item.run_id),
      action_id: text(item.action_id),
      action_title: text(item.action_title),
      parent_agent: await sessionAgent(item.parent_session_id, text(item.parent_agent)),
      child_session_id: child,
      agent: await sessionAgent(child, text(item.agent)),
      result_policy: text(item.result_policy),
      created_at: number(item.created_at),
      completed_at: number(item.completed_at),
      notified_at: number(item.notified_at),
      summary: text(item.summary) ?? out?.slice(0, 4000),
      ...(output && out !== undefined ? { output: out } : {}),
    }
  }

  async function full(item: Record<string, unknown>) {
    const ref = text(item.output_ref)
    if (!ref) return
    const data = await Storage.read<{ output?: string }>(ref.split("/")).catch(() => undefined)
    return data?.output
  }

  async function sessionAgent(id: unknown, fallback?: string) {
    const value = text(id)
    if (!value) return fallback
    const session = await Session.get(SessionID.make(value)).catch(() => undefined)
    return session?.agent ?? fallback
  }

  function clean(item: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(item).filter((entry) => entry[0] !== "agent" && entry[0] !== "parent_agent"),
    )
  }

  async function ctx(item: Item) {
    const agent = item.agent ? await Agent.get(item.agent).catch(() => undefined) : undefined
    const verifier = agent?.kind === "verifier" || item.agent?.includes("verifier") === true
    return {
      verifier,
      target: verifier ? anchor(item) : undefined,
    }
  }

  function anchor(item: Item) {
    const meta = object(item.metadata)
    const worker = text(object(meta.verification).worker)
    if (worker) return worker
    const deps = object(item).depends_on
    const dep = Array.isArray(deps) ? deps.map(text).find((entry): entry is string => Boolean(entry)) : undefined
    if (dep) return dep
    return infer(item.action_id)
  }

  function infer(input: string | undefined) {
    if (!input) return
    for (const suffix of ["_test", "_review"]) {
      if (input.endsWith(suffix)) return input.slice(0, -suffix.length)
    }
  }

  function match(
    item: Row,
    input: {
      childID?: string
      status?: QueryStatus
    },
  ) {
    if (input.childID && item.child_session_id !== input.childID) return false
    if (input.status && item.status !== input.status) return false
    return true
  }

  function statusof(item: { status?: unknown }) {
    if (
      item.status === "completed" ||
      item.status === "partial" ||
      item.status === "blocked" ||
      item.status === "failed" ||
      item.status === "waiting_user"
    )
      return item.status
  }

  function settle(sessionID: SessionID, status: Status) {
    const next =
      status === "completed" || status === "partial"
        ? { type: "completed" as const }
        : status === "blocked"
          ? { type: "blocked" as const }
          : status === "failed"
            ? { type: "failed" as const }
            : { type: "waiting_user" as const }
    const current = SessionStatus.get(sessionID).type
    const allowed = {
      completed: ["idle", "running", "rate_limited", "waiting_child", "completed"],
      blocked: [
        "idle",
        "queued",
        "starting",
        "running",
        "rate_limited",
        "waiting_permission",
        "waiting_user",
        "waiting_child",
        "error",
        "timeout",
        "retry",
        "paused",
        "aborting",
        "failed",
        "blocked",
        "interrupted",
      ],
      failed: [
        "idle",
        "queued",
        "starting",
        "running",
        "rate_limited",
        "waiting_permission",
        "waiting_user",
        "waiting_child",
        "error",
        "timeout",
        "retry",
        "paused",
        "aborting",
        "failed",
        "blocked",
        "interrupted",
      ],
      waiting_user: [
        "idle",
        "starting",
        "running",
        "rate_limited",
        "waiting_permission",
        "waiting_user",
        "waiting_child",
      ],
    }[next.type]
    if (!allowed.includes(current)) return
    SessionStatus.set(sessionID, next)
  }

  async function meta(agent: string, status: "completed" | "failed", output: string) {
    const cfg = await AgentDelegation.meta(agent).catch(() => undefined)
    const done = AgentDelegation.complete({
      agent,
      meta: cfg,
      result: {
        content: output,
        source: agent,
      },
      status,
    })
    return done
  }

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function text(input: unknown) {
    if (typeof input === "string") return input
  }

  function number(input: unknown) {
    if (typeof input === "number") return input
  }
}
