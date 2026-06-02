import { Bus } from "@/bus"
import { AgentDelegation } from "@/agent/delegation"
import { Instance } from "@/project/instance"
import type { AgentProtocol } from "@/protocol/schema"
import { NotFoundError } from "@/storage/db"
import { Log } from "@/util/log"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionLog } from "./log"
import { MessageID, SessionID } from "./schema"

export namespace SessionDelegation {
  const log = Log.create({ service: "session.delegation" })
  const wait = "The parent session will resume automatically when the child result is available."
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
  type Item = {
    type: "agent.delegation.assignment"
    version: "1"
    run_id: string
    action_id: string
    action_title: string
    parent_session_id: string
    parent_message_id: string
    parent_agent: string
    child_session_id: string
    agent: string
    metadata?: ReturnType<typeof AgentDelegation.runtime>
    result_policy: string
    created_at: number
    status?: Status
    completed_at?: number
    completed_message_id?: MessageID
    notified_at?: number
    output?: string
    result_metadata?: ReturnType<typeof AgentDelegation.complete>
    summary?: string
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
            [input.childID]: packet(input),
          },
        },
      },
    })

    const child = await Session.get(input.childID)
    const childctx = object(child.dsl_context)
    const childprev = object(childctx.protocol)
    await Session.setDslContext({
      sessionID: input.childID,
      dsl_context: {
        ...childctx,
        protocol: {
          ...childprev,
          delegation: packet(input),
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
    const done = await meta(input.agent, input.result.info.role === "assistant" && input.result.info.finish === "error" ? "failed" : "completed", output)
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
    return complete({
      sessionID: input.childID,
      messageID: input.messageID,
      metadata: await meta(input.agent, "failed", input.error instanceof Error ? input.error.message : String(input.error)),
      status: "failed",
      output: input.error instanceof Error ? input.error.message : String(input.error),
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
      const found = input.output === undefined ? await result(input.sessionID, input.messageID) : undefined
      const status = input.status ?? statusof(item) ?? found?.status
      const output = input.output ?? text(item.output) ?? found?.output
      if (!status || output === undefined) return false
      if (output.includes(wait)) return false

      const body = completed(item, status, output, input.metadata ?? item.result_metadata)
      const fresh = statusof(item) !== status || text(item.output) !== output
      if (fresh) {
        await logdone(body)
        await logmeta(body)
        await store(input.sessionID, item, body, input.messageID)
      }
      const next = assignment(await Session.get(input.sessionID))
      if (!next || typeof next.notified_at === "number") return false
      await notify(body)
      await notified(input.sessionID, next)
      return true
    } finally {
      ctx.busy.delete(input.sessionID)
    }
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
    const pending = Object.entries(object(prev.pending_delegations))
      .map(([id, item]) => row(item, "pending", input.output === true, id))
      .filter((item): item is NonNullable<typeof item> => !!item)
      .filter((item) => match(item, input))
    const done = (Array.isArray(prev.completed_delegations) ? prev.completed_delegations : [])
      .map((item) => row(item, "completed", input.output === true))
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
    if (!info.finish || info.finish === "tool-calls" || info.finish === "unknown") return
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
      typeof data.agent !== "string" ||
      typeof data.child_session_id !== "string" ||
      typeof data.parent_agent !== "string" ||
      typeof data.parent_message_id !== "string" ||
      typeof data.parent_session_id !== "string" ||
      typeof data.result_policy !== "string" ||
      typeof data.run_id !== "string"
    ) return
    return data as Item
  }

  async function result(sessionID: SessionID, messageID?: MessageID) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID)).catch((err: unknown) => {
      if (err instanceof NotFoundError) return []
      throw err
    })
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
    if (msg.info.error) {
      const data = "data" in msg.info.error ? msg.info.error.data : undefined
      const err = object(data)
      return {
        status: "failed" as const,
        output: typeof err.message === "string" ? err.message : "Delegated child session failed",
      }
    }
    return {
      status: msg.info.finish === "error" ? "failed" as const : "completed" as const,
      output: msg.parts.findLast((part) => part.type === "text")?.text ?? "",
    }
  }

  function completed(item: Item, status: Status, output: string, meta?: ReturnType<typeof AgentDelegation.complete>) {
    return {
      type: "agent.delegation.result",
      version: "1",
      status,
      run_id: item.run_id as string,
      action_id: item.action_id as string,
      action_title: item.action_title as string,
      parent_session_id: item.parent_session_id as string,
      parent_message_id: item.parent_message_id as string,
      parent_agent: item.parent_agent as string,
      child_session_id: item.child_session_id as string,
      agent: item.agent as string,
      metadata: meta,
      result_policy: item.result_policy,
      completed_at: typeof item.completed_at === "number" ? item.completed_at : Date.now(),
      summary: output.slice(0, 4000),
      output,
    }
  }

  async function store(sessionID: SessionID, item: Item, body: ReturnType<typeof completed>, messageID?: MessageID) {
    const parent = await Session.get(SessionID.make(item.parent_session_id as string))
    const ctx = object(parent.dsl_context)
    const prev = object(ctx.protocol)
    const pending = { ...object(prev.pending_delegations) }
    delete pending[sessionID]
    const done = Array.isArray(prev.completed_delegations) ? prev.completed_delegations : []
    await Session.setDslContext({
      sessionID: parent.id,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          pending_delegations: pending,
          completed_delegations: [
            ...done.filter((entry) => !object(entry) || entry.child_session_id !== sessionID),
            body,
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
        protocol: {
          ...childprev,
          delegation: {
            ...item,
            status: body.status,
            completed_at: body.completed_at,
            completed_message_id: messageID,
            output: body.output,
            result_metadata: body.metadata,
            summary: body.summary,
          },
        },
      },
    })
  }

  async function notify(body: ReturnType<typeof completed>) {
    const { SessionPrompt } = await import("./prompt")
    await SessionPrompt.prompt({
      sessionID: SessionID.make(body.parent_session_id as string),
      agent: body.parent_agent,
      parts: [
        {
          type: "text",
          text: [
            "A delegated agent task has completed. Continue the parent task using this result.",
            "",
            "<agent-delegation-result>",
            JSON.stringify(body, null, 2),
            "</agent-delegation-result>",
            "",
            "Use the result to decide the next step. If more delegated work is needed, issue the next AgentProtocolOutput package. If the parent task is complete, answer the user with the current status.",
          ].join("\n"),
        },
      ],
    })
  }

  async function notified(sessionID: SessionID, item: Item) {
    const child = await Session.get(sessionID)
    const ctx = object(child.dsl_context)
    const prev = object(ctx.protocol)
    await Session.setDslContext({
      sessionID,
      dsl_context: {
        ...ctx,
        protocol: {
          ...prev,
          delegation: {
            ...item,
            notified_at: Date.now(),
          },
        },
      },
    })
  }

  async function logdone(body: ReturnType<typeof completed>) {
    await SessionLog.emit({
      sessionID: SessionID.make(body.parent_session_id as string),
      messageID: MessageID.make(body.parent_message_id as string),
      level: body.status === "failed" ? "warn" : "info",
      type: body.status === "failed" ? "protocol.agent.failed" : "protocol.agent.completed",
      data: {
        actionID: body.action_id,
        agent: body.agent,
        childSessionID: body.child_session_id,
        outputBytes: typeof body.output === "string" ? body.output.length : 0,
      },
    })
  }

  async function logmeta(body: ReturnType<typeof completed>) {
    if (!body.metadata) return
    await SessionLog.emit({
      sessionID: SessionID.make(body.parent_session_id),
      messageID: MessageID.make(body.parent_message_id),
      level: body.metadata.status === "completed" ? "info" : "warn",
      type: body.metadata.validation.status === "valid" ? "agent.metadata.output_validated" : "agent.metadata.output_validation_failed",
      data: {
        agent: body.agent,
        status: body.metadata.status,
        artifacts: body.metadata.artifacts,
        validation: body.metadata.validation,
        completion: body.metadata.completion,
      },
    })
    if (body.metadata.status === "completed") return
    const cfg = await AgentDelegation.meta(body.agent).catch(() => undefined)
    const msgs = AgentDelegation.messages({ meta: cfg, event: "output_validation_failed" })
    if (!msgs.records.length && !msgs.diagnostics.length) return
    await SessionLog.emit({
      sessionID: SessionID.make(body.parent_session_id),
      messageID: MessageID.make(body.parent_message_id),
      level: "warn",
      type: "agent.metadata.messages",
      data: {
        agent: body.agent,
        event: "output_validation_failed",
        records: msgs.records,
        diagnostics: msgs.diagnostics,
      },
    })
  }

  function row(input: unknown, fallback: QueryStatus, output: boolean, childID?: string) {
    const item = object(input)
    const child = text(item.child_session_id) ?? childID
    if (!child) return
    const out = text(item.output)
    return {
      status: statusof(item) ?? fallback,
      run_id: text(item.run_id),
      action_id: text(item.action_id),
      action_title: text(item.action_title),
      parent_agent: text(item.parent_agent),
      child_session_id: child,
      agent: text(item.agent),
      result_policy: text(item.result_policy),
      created_at: number(item.created_at),
      completed_at: number(item.completed_at),
      notified_at: number(item.notified_at),
      summary: text(item.summary) ?? out?.slice(0, 4000),
      ...(output && out !== undefined ? { output: out } : {}),
    }
  }

  function match(item: NonNullable<ReturnType<typeof row>>, input: {
    childID?: string
    status?: QueryStatus
  }) {
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
    ) return item.status
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
