import { randomUUID } from "crypto"
import { QuestionID } from "@/question/schema"
import type { Question } from "@/question"
import { Instance } from "@/project/instance"
import { and, Database, eq, inArray, lt, or } from "@/storage/db"
import { Log } from "@/util/log"
import { MessageID, SessionID } from "./schema"
import { RuntimeInteractionTable, SessionEventOutboxTable, SessionTable } from "./session.sql"
import { SessionStatus } from "./status"

export namespace SessionInteraction {
  const log = Log.create({ service: "session.interaction" })
  const ttl = 30_000

  export type Kind = typeof RuntimeInteractionTable.$inferInsert.kind

  export function request(input: {
    sessionID: SessionID
    runID: string
    actionID: string
    kind: "protocol_confirm" | "protocol_input"
  }) {
    const prefix = input.kind === "protocol_confirm" ? "que_protocol_confirm_" : "que_protocol_input_"
    return QuestionID.make(
      `${prefix}${Buffer.from(
        JSON.stringify({ sessionID: input.sessionID, run: input.runID, action: input.actionID }),
      ).toString("base64url")}`,
    )
  }

  export function open(input: {
    requestID: QuestionID
    sessionID: SessionID
    questions: Question.Info[]
    tool?: { messageID: MessageID; callID: string }
    kind?: Kind
    runID?: string
    actionID?: string
    payload?: Record<string, unknown>
    checkpoint?: Record<string, unknown>
  }) {
    const now = Date.now()
    const exists = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!exists) return
    const row = Database.transaction(
      (tx) => {
        const prior = tx
          .select()
          .from(RuntimeInteractionTable)
          .where(eq(RuntimeInteractionTable.request_id, input.requestID))
          .get()
        if (prior) return prior
        return tx
          .insert(RuntimeInteractionTable)
          .values({
            id: `interaction_${randomUUID()}`,
            session_id: input.sessionID,
            run_id: input.runID,
            action_id: input.actionID,
            message_id: input.tool?.messageID,
            request_id: input.requestID,
            kind: input.kind ?? "question",
            status: "pending",
            payload: {
              questions: input.questions,
              tool: input.tool,
              ...input.payload,
            },
            checkpoint: input.checkpoint,
            generation: 1,
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get()
      },
      { behavior: "immediate" },
    )
    const status = SessionStatus.get(input.sessionID).type
    if (row.status === "pending" && status !== "queued" && status !== "running")
      SessionStatus.set(input.sessionID, { type: "waiting_user" })
    return row
  }

  export function pending() {
    return Database.use((db) =>
      db
        .select({ interaction: RuntimeInteractionTable })
        .from(RuntimeInteractionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, RuntimeInteractionTable.session_id))
        .where(
          and(
            eq(RuntimeInteractionTable.status, "pending"),
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
          ),
        )
        .all()
        .flatMap(({ interaction }) => {
          const questions = Array.isArray(interaction.payload.questions)
            ? (interaction.payload.questions as Question.Info[])
            : []
          if (!questions.length) return []
          const tool =
            interaction.payload.tool &&
            typeof interaction.payload.tool === "object" &&
            !Array.isArray(interaction.payload.tool)
              ? (interaction.payload.tool as { messageID: MessageID; callID: string })
              : undefined
          return [
            {
              id: interaction.request_id,
              sessionID: interaction.session_id,
              questions,
              tool,
            },
          ]
        }),
    )
  }

  export function resolve(input: {
    requestID: QuestionID
    answers: Question.Answer[]
    response?: Question.Reply["response"]
    rejected?: boolean
    resume: boolean
    text?: string
    source?: string
    schedule?: boolean
  }) {
    const now = Date.now()
    const result = Database.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(RuntimeInteractionTable)
          .where(eq(RuntimeInteractionTable.request_id, input.requestID))
          .get()
        if (!row) return
        if (row.status !== "pending") return { row, replay: true as const }
        const status = input.rejected
          ? "rejected"
          : input.response === "confirm"
            ? "confirmed"
            : input.response === "cancel"
              ? "cancelled"
              : "answered"
        const decision = {
          answers: input.answers,
          response: input.response,
          rejected: input.rejected === true,
        }
        const saved = tx
          .update(RuntimeInteractionTable)
          .set({
            status,
            decision,
            time_resolved: now,
            time_updated: now,
          })
          .where(
            and(
              eq(RuntimeInteractionTable.id, row.id),
              eq(RuntimeInteractionTable.status, "pending"),
              eq(RuntimeInteractionTable.generation, row.generation),
            ),
          )
          .returning()
          .get()
        if (!saved) return
        if (!input.resume) return { row: saved, replay: false as const }
        const key = `runtime_continuation:${saved.id}:${saved.generation}`
        const message = MessageID.ascending()
        tx.insert(SessionEventOutboxTable)
          .values({
            id: `outbox_${randomUUID()}`,
            session_id: saved.session_id,
            target_session_id: saved.session_id,
            kind: "runtime_continuation",
            dedupe_key: key,
            status: "pending",
            payload: {
              interaction_id: saved.id,
              generation: saved.generation,
              message_id: message,
              checkpoint_message_id: saved.message_id,
              checkpoint_run_id: saved.run_id,
              source: input.source ?? saved.kind,
              text: input.text ?? continuation(saved, decision),
            },
            created_at: now,
            updated_at: now,
          })
          .onConflictDoNothing()
          .run()
        return { row: saved, replay: false as const }
      },
      { behavior: "immediate" },
    )
    if (result?.row && input.resume && !result.replay) {
      SessionStatus.set(result.row.session_id, { type: "queued" })
      if (input.schedule !== false) Database.effect(() => scan())
    }
    if (result?.row && !input.resume && !result.replay && SessionStatus.get(result.row.session_id).type === "waiting_user")
      SessionStatus.set(result.row.session_id, { type: "idle" })
    return result
  }

  export function ready(input: { sessionID: SessionID; runID: string; schedule?: boolean }) {
    const now = Date.now()
    const rows = Database.transaction(
      (tx) => {
        const rows = tx
          .select()
          .from(RuntimeInteractionTable)
          .where(
            and(
              eq(RuntimeInteractionTable.session_id, input.sessionID),
              eq(RuntimeInteractionTable.run_id, input.runID),
            ),
          )
          .all()
        return rows.map((row) =>
          tx
            .update(RuntimeInteractionTable)
            .set({ checkpoint: { ...row.checkpoint, ready: true }, time_updated: now })
            .where(eq(RuntimeInteractionTable.id, row.id))
            .returning()
            .get(),
        )
      },
      { behavior: "immediate" },
    )
    if (input.schedule !== false && rows.some((row) => row && row.status !== "pending"))
      Database.effect(() => scan())
  }

  export async function scan(input?: { recover?: boolean }) {
    await reconcile()
    const rows = Database.use((db) =>
      db
        .select({ outbox: SessionEventOutboxTable })
        .from(SessionEventOutboxTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionEventOutboxTable.session_id))
        .where(
          and(
            eq(SessionEventOutboxTable.kind, "runtime_continuation"),
            or(
              inArray(SessionEventOutboxTable.status, ["pending", "failed"]),
              and(
                eq(SessionEventOutboxTable.status, "delivering"),
                lt(SessionEventOutboxTable.updated_at, Date.now() - ttl),
              ),
            ),
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
          ),
        )
        .all(),
    )
    return Promise.all(rows.map((item) => start(item.outbox, input?.recover === true)))
  }

  async function reconcile() {
    const rows = Database.use((db) =>
      db
        .select({ id: SessionTable.id, ctx: SessionTable.dsl_context })
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, Instance.project.id), eq(SessionTable.directory, Instance.directory)))
        .all(),
    )
    for (const row of rows) {
      const protocol = record(record(row.ctx).protocol)
      const groups = [
        { kind: "protocol_confirm" as const, items: protocol.confirmations },
        { kind: "protocol_input" as const, items: protocol.inputs },
      ]
      for (const group of groups) {
        if (!Array.isArray(group.items)) continue
        for (const value of group.items) {
          const item = record(value)
          const run = string(item.run_id)
          const action = string(item.action_id)
          const message = string(item.message_id)
          if (!run || !action || !message) continue
          const requestID = request({ sessionID: row.id, runID: run, actionID: action, kind: group.kind })
          const qs =
            group.kind === "protocol_input" && Array.isArray(item.questions)
              ? (item.questions as Question.Info[])
              : [
                  {
                    question: string(item.plan) ?? string(item.action_title) ?? action,
                    header: "Confirm plan",
                    options: [
                      { label: "Confirm", description: "Approve this plan and continue execution." },
                      { label: "Cancel", description: "Do not execute this plan." },
                    ],
                    custom: false,
                  },
                ]
          await open({
            requestID,
            sessionID: row.id,
            questions: qs,
            tool: { messageID: MessageID.make(message), callID: `call_${action}` },
            kind: record(item.assignment_intent).op || record(item.assignment).op ? "task_confirm" : group.kind,
            runID: run,
            actionID: action,
            checkpoint: { run_id: run, action_id: action, ready: true },
          })
          const { MessageV2 } = await import("./message-v2")
          const parts = await MessageV2.parts(MessageID.make(message))
          if (
            parts.some(
              (part) =>
                part.type === "text" &&
                part.metadata?.kind === "protocol_summary" &&
                record(part.metadata.protocol).runID === run,
            )
          )
            ready({ sessionID: row.id, runID: run, schedule: false })
          if (item.status === "pending") continue
          const response = item.status === "confirmed" ? "confirm" : item.status === "cancelled" ? "cancel" : undefined
          const assignment = record(item.assignment_intent).op || record(item.assignment).op
          resolve({
            requestID,
            answers: Array.isArray(item.answers) ? (item.answers as Question.Answer[]) : [],
            response,
            rejected: item.status === "rejected",
            resume: group.kind === "protocol_input" || !assignment,
            source: "recovery_reconcile",
            schedule: false,
          })
        }
      }
    }
  }

  async function start(row: typeof SessionEventOutboxTable.$inferSelect, recover: boolean) {
    const id = typeof row.payload.interaction_id === "string" ? row.payload.interaction_id : undefined
    const interaction = id
      ? Database.use((db) =>
          db.select().from(RuntimeInteractionTable).where(eq(RuntimeInteractionTable.id, id)).get(),
        )
      : undefined
    if (!recover && interaction && interaction.checkpoint?.ready !== true) return false
    const now = Date.now()
    const token = randomUUID()
    const payload = { ...row.payload, owner_token: token, lease_until: now + ttl }
    const claimed = Database.transaction(
      (tx) =>
        tx
          .update(SessionEventOutboxTable)
          .set({ status: "delivering", payload, updated_at: now, error: null })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              inArray(SessionEventOutboxTable.status, ["pending", "failed", "delivering"]),
              eq(SessionEventOutboxTable.updated_at, row.updated_at),
            ),
          )
          .returning()
          .get(),
      { behavior: "immediate" },
    )
    if (!claimed) return false
    const message =
      typeof claimed.payload.message_id === "string"
        ? MessageID.make(claimed.payload.message_id)
        : MessageID.ascending()
    const text = typeof claimed.payload.text === "string" ? claimed.payload.text : "Continue the resolved interaction."
    const timer = setInterval(() => renew(claimed.id, token), ttl / 3)
    try {
      if (claimed.payload.source === "protocol_confirmation") {
        const { SessionRunner } = await import("./runner")
        if (SessionRunner.active(claimed.session_id)) return release(claimed, token)
        const checkpoint =
          typeof claimed.payload.checkpoint_message_id === "string"
            ? MessageID.make(claimed.payload.checkpoint_message_id)
            : undefined
        const runID =
          typeof claimed.payload.checkpoint_run_id === "string" ? claimed.payload.checkpoint_run_id : undefined
        if (!(await SessionRunner.resume({ sessionID: claimed.session_id, messageID: checkpoint, runID })))
          throw new Error(`Persisted protocol continuation is not resumable: ${claimed.session_id}`)
        return finish(claimed, token, "delivered")
      }
      const { MessageV2 } = await import("./message-v2")
      const { SessionPrompt } = await import("./prompt")
      const { Session } = await import(".")
      const prior = await MessageV2.get({ sessionID: claimed.session_id, messageID: message }).catch(() => undefined)
      const session = await Session.get(claimed.session_id)
      const agent =
        session.agent ??
        (await (async () => {
          for await (const item of MessageV2.stream(claimed.session_id)) {
            if (item.info.role !== "user" || !item.info.agent) continue
            return item.info.agent
          }
        })())
      if (prior) await SessionPrompt.loop({ sessionID: claimed.session_id, messageID: message })
      if (!prior)
        await SessionPrompt.prompt({
          sessionID: claimed.session_id,
          messageID: message,
          agent,
          metadata: {
            internal: true,
            source: "runtime_continuation",
            interaction_id: claimed.payload.interaction_id,
          },
          parts: [{ type: "text", text }],
        })
      return finish(claimed, token, "delivered")
    } catch (err) {
      finish(claimed, token, "failed", err)
      log.warn("runtime continuation failed", { err, outboxID: claimed.id })
      return false
    } finally {
      clearInterval(timer)
    }
  }

  function finish(
    row: typeof SessionEventOutboxTable.$inferSelect,
    token: string,
    status: "delivered" | "failed",
    err?: unknown,
  ) {
    const now = Date.now()
    return Database.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(SessionEventOutboxTable)
          .where(eq(SessionEventOutboxTable.id, row.id))
          .get()
        if (current?.status !== "delivering" || current.payload.owner_token !== token) return false
        const saved = tx
          .update(SessionEventOutboxTable)
          .set({
            status,
            delivered_at: status === "delivered" ? now : null,
            updated_at: now,
            error: err === undefined ? null : err instanceof Error ? err.message : String(err),
          })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              eq(SessionEventOutboxTable.status, "delivering"),
              eq(SessionEventOutboxTable.payload, current.payload),
            ),
          )
          .returning()
          .get()
        if (!saved || status !== "delivered") return !!saved
        const id = typeof saved.payload.interaction_id === "string" ? saved.payload.interaction_id : undefined
        if (id)
          tx.update(RuntimeInteractionTable)
            .set({ status: "completed", time_updated: now })
            .where(eq(RuntimeInteractionTable.id, id))
            .run()
        return true
      },
      { behavior: "immediate" },
    )
  }

  function release(row: typeof SessionEventOutboxTable.$inferSelect, token: string) {
    const now = Date.now()
    return Database.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(SessionEventOutboxTable)
          .where(eq(SessionEventOutboxTable.id, row.id))
          .get()
        if (current?.status !== "delivering" || current.payload.owner_token !== token) return false
        return !!tx
          .update(SessionEventOutboxTable)
          .set({
            status: "pending",
            payload: { ...current.payload, owner_token: undefined, lease_until: undefined },
            updated_at: now,
            error: null,
          })
          .where(
            and(
              eq(SessionEventOutboxTable.id, row.id),
              eq(SessionEventOutboxTable.status, "delivering"),
              eq(SessionEventOutboxTable.payload, current.payload),
            ),
          )
          .returning()
          .get()
      },
      { behavior: "immediate" },
    )
  }

  function renew(id: string, token: string) {
    const now = Date.now()
    Database.transaction(
      (tx) => {
        const row = tx.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.id, id)).get()
        if (row?.status !== "delivering" || row.payload.owner_token !== token) return
        tx.update(SessionEventOutboxTable)
          .set({ payload: { ...row.payload, lease_until: now + ttl }, updated_at: now })
          .where(
            and(
              eq(SessionEventOutboxTable.id, id),
              eq(SessionEventOutboxTable.status, "delivering"),
              eq(SessionEventOutboxTable.payload, row.payload),
            ),
          )
          .run()
      },
      { behavior: "immediate" },
    )
  }

  function continuation(
    row: typeof RuntimeInteractionTable.$inferSelect,
    decision: { answers: Question.Answer[]; response?: Question.Reply["response"]; rejected: boolean },
  ) {
    const answers = decision.answers.flat().map((item) => `- ${item}`).join("\n")
    return [
      `Runtime interaction ${row.id} has been resolved.`,
      row.run_id && row.action_id ? `Protocol position: ${row.run_id}:${row.action_id}.` : "",
      decision.rejected ? "The user rejected the request." : `Decision: ${decision.response ?? "answered"}.`,
      answers,
      "Continue from the persisted protocol state. Do not ask for the same interaction again.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  function record(input: unknown): Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  }

  function string(input: unknown) {
    return typeof input === "string" ? input : undefined
  }
}
