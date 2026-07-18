import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Instance } from "@/project/instance"
import {
  and,
  ConflictError,
  Database,
  eq,
  ForbiddenError,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  NotFoundError,
  or,
} from "@/storage/db"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { Session } from "."
import { SessionAssignment } from "./assignment"
import { SessionTaskHandoff } from "./task-handoff"
import { SessionTask } from "./task"
import { SessionTaskRecovery } from "./task-recovery"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"
import { SessionPrompt } from "./prompt"
import {
  AssignmentTable,
  SessionEventOutboxTable,
  SessionTable,
  SessionTaskTable,
  TaskConfirmationTable,
  TaskHandoffTable,
} from "./session.sql"

export namespace SessionTaskConfirmation {
  const log = Log.create({ service: "session.task-confirmation" })
  export type Action = "confirm" | "cancel"

  export async function respond(input: {
    sessionID: SessionID
    proposalID: string
    action: Action
    op: "update" | "handoff"
    handoffID?: string
    revisionID?: string
  }) {
    const split = input.proposalID.indexOf(":")
    if (split < 1 || split === input.proposalID.length - 1)
      throw new ConflictError({ message: "Task proposal identity is invalid" })
    const run = input.proposalID.slice(0, split)
    const action = input.proposalID.slice(split + 1)
    const session = await Session.get(input.sessionID)
    const ctx = rec(session.dsl_context) ? session.dsl_context : {}
    const protocol = rec(ctx.protocol) ? ctx.protocol : {}
    const vals = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
    const found = vals.filter((item) => rec(item) && item.run_id === run && item.action_id === action)
    if (found.length !== 1 || !rec(found[0])) {
      if (owner(input.sessionID, run, action))
        throw new ForbiddenError({ message: `Task proposal does not belong to session: ${input.sessionID}` })
      throw new ConflictError({ message: `Task proposal is not current: ${input.proposalID}` })
    }
    const item = found[0]
    const intent = rec(item.assignment_intent) ? item.assignment_intent : rec(item.assignment) ? item.assignment : {}
    const target = input.op === "handoff" ? "peer" : "self"
    if (intent.op !== input.op || intent.target !== target)
      throw new ConflictError({ message: `Task proposal intent is invalid: ${input.proposalID}` })
    if (item.status !== "pending" && item.status !== (input.action === "confirm" ? "confirmed" : "cancelled"))
      throw new ConflictError({ message: `Task proposal cannot be ${input.action}ed: ${input.proposalID}` })
    const message = text(item.message_id)
    const plan = text(item.plan)
    const title = text(item.action_title) ?? action
    if (!message || plan === undefined || !title)
      throw new ConflictError({ message: `Task proposal proof is incomplete: ${input.proposalID}` })
    if (input.op === "update" && input.handoffID)
      throw new ConflictError({ message: `Task update cannot use handoff proof: ${input.handoffID}` })
    const handoff = input.op === "handoff" && input.handoffID ? await SessionTaskHandoff.get(input.handoffID) : undefined
    if (input.op === "handoff" && !handoff)
      throw new NotFoundError({ message: `Task handoff not found: ${input.handoffID}` })
    if (handoff && handoff.source_session_id !== input.sessionID)
      throw new ForbiddenError({ message: `Task handoff does not belong to session: ${input.sessionID}` })
    if (handoff && input.action === "cancel" && handoff.status !== "proposed" && handoff.status !== "cancelled")
      throw new ConflictError({ message: `Task handoff is already ${handoff.status}: ${handoff.id}` })
    if (handoff?.status === "cancelled" && input.action === "confirm")
      throw new ConflictError({ message: `Task handoff is already cancelled: ${handoff.id}` })
    if (handoff && (handoff.source_message_id !== message || handoff.title !== title || handoff.body !== plan))
      throw new ConflictError({ message: `Task handoff proof is invalid: ${handoff.id}` })
    const snapshot = snap(input.sessionID, item, handoff)
    const status = input.action === "confirm" ? "confirmed" : "cancelled"
    const durable = Database.use((db) =>
      db
        .select({ id: TaskConfirmationTable.id })
        .from(TaskConfirmationTable)
        .where(
          and(
            eq(TaskConfirmationTable.session_id, input.sessionID),
            eq(TaskConfirmationTable.proposal_id, input.proposalID),
          ),
        )
        .get(),
    )
    const imported =
      !durable && item.status === status
        ? await legacy(input, item, snapshot, run, action, title, plan, message)
        : undefined
    const claimed = claim({
      sessionID: input.sessionID,
      proposalID: input.proposalID,
      action: input.action,
      op: input.op,
      revisionID: input.revisionID,
      handoffID: input.handoffID,
      run,
      actionID: action,
      snapshot,
      hash: digest(snapshot),
      handoff,
      imported,
    })
    const proof = claimed.owner ? claimed.row : await settled(claimed.row)
    const beat = claimed.owner ? pulse(proof) : undefined

    try {
      if (proof.status === "completed" || proof.status === "cancelled") {
        if (rec(proof.result)) {
          if (input.op === "handoff" && input.action === "confirm" && handoff) {
            const transfer =
              handoff.status === "failed" && proof.assignment_id
                ? await safe(SessionTaskHandoff.confirm(handoff.id, { assignmentID: proof.assignment_id }))
                : handoff
            return {
              ...proof.result,
              status: transfer.status,
              target_session_id: transfer.target_session_id ?? undefined,
              target_task_id: transfer.target_task_id ?? undefined,
            }
          }
          if (input.op === "update" && input.action === "confirm") {
            const task = await SessionTask.get(input.sessionID)
            if (task?.task.status === "blocked") await SessionTaskRecovery.resume(input.sessionID)
            return { ...proof.result, status: "revising" }
          }
          return proof.result
        }
        throw new ConflictError({ message: `Task confirmation result is missing: ${proof.id}` })
      }
      if (item.status === status) {
        const saved = proof.assignment_id ?? (rec(item.assignment) ? text(item.assignment.id) : undefined)
        return {
          proposal_id: input.proposalID,
          action: input.action,
          assignment_id: saved,
          status: input.op === "update" && input.action === "confirm" ? "revising" : handoff?.status,
          target_session_id: handoff?.target_session_id ?? undefined,
          target_task_id: handoff?.target_task_id ?? undefined,
        }
      }

      beat?.guard()
      const assignment = proof.assignment_id
        ? await SessionAssignment.get(proof.assignment_id)
        : input.action === "confirm"
          ? await safe(
              SessionAssignment.apply({
                actionID: action,
                assignment: intent,
                messageID: MessageID.make(message),
                plan,
                runID: run,
                sessionID: input.sessionID,
                title,
              }),
            )
          : undefined
      if (input.action === "confirm" && !assignment)
        throw new ConflictError({ message: `Task proposal assignment is invalid: ${input.proposalID}` })
      fence(proof)
      if (assignment && !proof.assignment_id)
        Database.use((db) =>
          db
            .update(TaskConfirmationTable)
            .set({ assignment_id: assignment.id, status: "continuation_pending", time_updated: Date.now() })
            .where(
              and(
                eq(TaskConfirmationTable.id, proof.id),
                owned(proof.owner_token),
                eq(TaskConfirmationTable.generation, proof.generation),
                gt(TaskConfirmationTable.lease_until, Date.now()),
              ),
            )
            .returning({ id: TaskConfirmationTable.id })
            .get(),
        )
      fence(proof)
      beat?.guard()
      const transfer =
        assignment && handoff
          ? await safe(SessionTaskHandoff.confirm(handoff.id, { assignmentID: assignment.id }))
          : input.action === "cancel" && handoff
            ? await safe(SessionTaskHandoff.cancel(handoff.id))
            : undefined
      if (input.action === "cancel" && handoff && transfer?.status !== "cancelled")
        throw new ConflictError({ message: `Task handoff could not be cancelled: ${handoff.id}` })
      fence(proof)
      const live = (await Question.list()).find(
        (request) =>
          request.sessionID === input.sessionID &&
          request.tool?.messageID === message &&
          request.tool.callID === `call_${action}`,
      )
      await deliver(proof, input.sessionID, run, action, input.action, live?.id, beat)
      fence(proof)
      const result = {
        proposal_id: input.proposalID,
        action: input.action,
        assignment_id: assignment?.id,
        status: input.op === "update" && input.action === "confirm" ? "revising" : transfer?.status,
        target_session_id: transfer?.target_session_id ?? undefined,
        target_task_id: transfer?.target_task_id ?? undefined,
      }
      beat?.guard()
      const saved = complete(proof, result, status, assignment)
      await Storage.write(["session_protocol_confirmation", input.sessionID, run, action], saved)
      return result
    } finally {
      beat?.stop()
    }
  }

  export async function scan(run = respond) {
    const start = Date.now()
    const rows = Database.use((db) =>
      db
        .select()
        .from(TaskConfirmationTable)
        .innerJoin(SessionTable, eq(SessionTable.id, TaskConfirmationTable.session_id))
        .where(
          and(
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
            or(
              eq(TaskConfirmationTable.status, "failed"),
              and(
                inArray(TaskConfirmationTable.status, ["claimed", "continuation_pending"]),
                lt(TaskConfirmationTable.time_updated, Date.now() - 30_000),
              ),
            ),
          ),
        )
        .all(),
    )
    const results: boolean[] = []
    for (let index = 0; index < rows.length; index += 4) {
      const batch = await Promise.all(
        rows.slice(index, index + 4).map((row) =>
          run({
            sessionID: row.task_confirmation.session_id,
            proposalID: row.task_confirmation.proposal_id,
            action: row.task_confirmation.decision,
            op: row.task_confirmation.operation,
            revisionID: row.task_confirmation.expected_revision_id ?? undefined,
            handoffID: row.task_confirmation.handoff_id ?? undefined,
          }).then(
            () => true,
            (err) => {
              log.warn("task confirmation recovery blocked", { confirmationID: row.task_confirmation.id, err })
              return false
            },
          ),
        ),
      )
      results.push(...batch)
    }
    log.info("task confirmation recovery scan complete", { candidates: rows.length, duration: Date.now() - start })
    return results
  }

  function rec(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
  }

  function text(input: unknown) {
    return typeof input === "string" ? input : undefined
  }

  function snap(
    sessionID: SessionID,
    item: Record<string, unknown>,
    handoff?: Pick<SessionTaskHandoff.Info, "id" | "context_refs">,
  ) {
    const intent = rec(item.assignment_intent) ? item.assignment_intent : rec(item.assignment) ? item.assignment : {}
    return {
      session_id: sessionID,
      message_id: text(item.message_id),
      run_id: text(item.run_id),
      action_id: text(item.action_id),
      title: text(item.action_title) ?? text(item.action_id),
      plan: text(item.plan),
      intent,
      ...(handoff ? { handoff_id: handoff.id, context_refs: handoff.context_refs } : {}),
    }
  }

  function digest(input: unknown) {
    return new Bun.CryptoHasher("sha256").update(canonical(input)).digest("hex")
  }

  function canonical(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`
    if (rec(input))
      return `{${Object.keys(input)
        .filter((key) => input[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
        .join(",")}}`
    return JSON.stringify(input)
  }

  function owner(sessionID: SessionID, run: string, action: string) {
    return Database.use((db) =>
      db
        .select({ id: SessionTable.id, ctx: SessionTable.dsl_context })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, Instance.project.id),
            eq(SessionTable.directory, Instance.directory),
            ne(SessionTable.id, sessionID),
          ),
        )
        .all()
        .find((row) => {
          const ctx = rec(row.ctx) ? row.ctx : {}
          const protocol = rec(ctx.protocol) ? ctx.protocol : {}
          const vals = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
          return vals.some((item) => rec(item) && item.run_id === run && item.action_id === action)
        }),
    )
  }

  async function safe<T>(value: Promise<T>) {
    try {
      return await value
    } catch (err) {
      if (err instanceof SessionAssignment.Conflict || err instanceof SessionTaskHandoff.Conflict)
        throw new ConflictError({ message: err.message })
      throw err
    }
  }

  function fence(proof: typeof TaskConfirmationTable.$inferSelect) {
    const valid = Database.use((db) =>
      db
        .select({ id: TaskConfirmationTable.id })
        .from(TaskConfirmationTable)
        .where(
          and(
            eq(TaskConfirmationTable.id, proof.id),
            owned(proof.owner_token),
            eq(TaskConfirmationTable.generation, proof.generation),
            gt(TaskConfirmationTable.lease_until, Date.now()),
          ),
        )
        .get(),
    )
    if (!valid) throw new ConflictError({ message: `Task confirmation lease was lost: ${proof.id}` })
  }

  function renew(proof: typeof TaskConfirmationTable.$inferSelect) {
    return Database.use(
      (db) =>
        !!db
          .update(TaskConfirmationTable)
          .set({ lease_until: Date.now() + ttl(), time_updated: Date.now() })
          .where(
            and(
              eq(TaskConfirmationTable.id, proof.id),
              owned(proof.owner_token),
              eq(TaskConfirmationTable.generation, proof.generation),
              gt(TaskConfirmationTable.lease_until, Date.now()),
            ),
          )
          .returning({ id: TaskConfirmationTable.id })
          .get(),
    )
  }

  function pulse(proof: typeof TaskConfirmationTable.$inferSelect) {
    let lost = false
    let timer: ReturnType<typeof setInterval> | undefined
    const lose = (err?: unknown) => {
      if (lost) return
      lost = true
      if (timer) clearInterval(timer)
      if (err) {
        log.error("task confirmation heartbeat failed", { confirmationID: proof.id, err })
        return
      }
      log.warn("task confirmation heartbeat lost", { confirmationID: proof.id })
    }
    const touch = () => {
      if (!renew(proof)) return false
      const key = `task_confirmation:${proof.id}`
      const row = Database.use((db) =>
        db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.dedupe_key, key)).get(),
      )
      if (!row || row.status !== "delivering") return true
      if (!rec(row.payload)) return false
      if (row.payload.owner_token !== proof.owner_token || row.payload.generation !== proof.generation)
        return typeof row.payload.lease_until === "number" && row.payload.lease_until < Date.now()
      const next = { ...row.payload, lease_until: Date.now() + ttl() }
      return Database.use(
        (db) =>
          !!db
            .update(SessionEventOutboxTable)
            .set({ payload: next, updated_at: Date.now() })
            .where(
              and(
                eq(SessionEventOutboxTable.id, row.id),
                eq(SessionEventOutboxTable.status, "delivering"),
                eq(SessionEventOutboxTable.payload, row.payload),
              ),
            )
            .returning({ id: SessionEventOutboxTable.id })
            .get(),
      )
    }
    const check = () => {
      try {
        if (touch()) return true
        lose()
      } catch (err) {
        lose(err)
      }
      return false
    }
    if (!check()) throw new ConflictError({ message: `Task confirmation lease was lost: ${proof.id}` })
    timer = setInterval(
      () => {
        if (!lost) check()
      },
      Math.max(10, Math.floor(ttl() / 3)),
    )
    return {
      guard() {
        if (!lost && check()) return
        throw new ConflictError({ message: `Task confirmation lease was lost: ${proof.id}` })
      },
      stop() {
        if (timer) clearInterval(timer)
      },
    }
  }

  function ttl() {
    const value = Number(process.env.OPENCODE_TASK_CONFIRMATION_LEASE_MS)
    return Number.isFinite(value) && value >= 30 ? value : 30_000
  }

  function owned(token: string | null) {
    return token === null ? isNull(TaskConfirmationTable.owner_token) : eq(TaskConfirmationTable.owner_token, token)
  }

  function complete(
    proof: typeof TaskConfirmationTable.$inferSelect,
    result: Record<string, unknown>,
    status: "confirmed" | "cancelled",
    assignment?: SessionAssignment.Info,
  ) {
    return Database.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(TaskConfirmationTable)
          .where(
            and(
              eq(TaskConfirmationTable.id, proof.id),
              owned(proof.owner_token),
              eq(TaskConfirmationTable.generation, proof.generation),
              gt(TaskConfirmationTable.lease_until, Date.now()),
            ),
          )
          .get()
        if (!current) throw new ConflictError({ message: `Task confirmation lease was lost: ${proof.id}` })
        if (current.snapshot_hash !== proof.snapshot_hash || digest(current.snapshot) !== current.snapshot_hash)
          throw new ConflictError({ message: `Task proposal proof changed: ${proof.proposal_id}` })
        const session = tx.select().from(SessionTable).where(eq(SessionTable.id, proof.session_id)).get()
        if (!session) throw new NotFoundError({ message: `Session not found: ${proof.session_id}` })
        const ctx = rec(session.dsl_context) ? session.dsl_context : {}
        const protocol = rec(ctx.protocol) ? ctx.protocol : {}
        const vals = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
        const next = vals.map((value) => {
          if (!rec(value) || `${value.run_id}:${value.action_id}` !== proof.proposal_id) return value
          const handoff = proof.handoff_id
            ? tx
                .select({ id: TaskHandoffTable.id, context_refs: TaskHandoffTable.context_refs })
                .from(TaskHandoffTable)
                .where(eq(TaskHandoffTable.id, proof.handoff_id))
                .get()
            : undefined
          if (
            (proof.operation === "handoff" && !handoff) ||
            digest(snap(proof.session_id, value, handoff)) !== proof.snapshot_hash
          )
            throw new ConflictError({ message: `Task proposal proof changed: ${proof.proposal_id}` })
          return {
            ...value,
            assignment: assignment
              ? {
                  id: assignment.id,
                  session_id: assignment.session_id,
                  status: assignment.status,
                  content_ref: assignment.content_ref,
                  content_version: assignment.content_version,
                }
              : value.assignment,
            response: current.decision,
            status,
            updated_at: Date.now(),
          }
        })
        const saved = next.find((value) => rec(value) && `${value.run_id}:${value.action_id}` === proof.proposal_id)
        if (!rec(saved)) throw new ConflictError({ message: `Task proposal is not current: ${proof.proposal_id}` })
        tx.update(SessionTable)
          .set({ dsl_context: { ...ctx, protocol: { ...protocol, confirmations: next } } })
          .where(eq(SessionTable.id, proof.session_id))
          .run()
        const committed = tx
          .update(TaskConfirmationTable)
          .set({
            status: current.decision === "confirm" ? "completed" : "cancelled",
            result,
            error: null,
            lease_until: 0,
            time_updated: Date.now(),
          })
          .where(
            and(
              eq(TaskConfirmationTable.id, proof.id),
              owned(proof.owner_token),
              eq(TaskConfirmationTable.generation, proof.generation),
              gt(TaskConfirmationTable.lease_until, Date.now()),
            ),
          )
          .returning({ id: TaskConfirmationTable.id })
          .get()
        if (!committed) throw new ConflictError({ message: `Task confirmation lease was lost: ${proof.id}` })
        return saved
      },
      { behavior: "immediate" },
    )
  }

  async function deliver(
    proof: typeof TaskConfirmationTable.$inferSelect,
    sessionID: SessionID,
    run: string,
    action: string,
    decision: Action,
    requestID: QuestionID | undefined,
    beat: ReturnType<typeof pulse> | undefined,
  ) {
    const key = `task_confirmation:${proof.id}`
    const now = Date.now()
    const outbox = Database.transaction(
      (tx) => {
        const valid = tx
          .select({ id: TaskConfirmationTable.id })
          .from(TaskConfirmationTable)
          .where(
            and(
              eq(TaskConfirmationTable.id, proof.id),
              owned(proof.owner_token),
              eq(TaskConfirmationTable.generation, proof.generation),
              gt(TaskConfirmationTable.lease_until, now),
            ),
          )
          .get()
        if (!valid) return
        const found = tx.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.dedupe_key, key)).get()
        if (found?.status === "delivered" || found?.status === "acked") return found
        const prior = rec(found?.payload) ? found.payload : {}
        const mode = "prompt"
        const request = text(prior.request_id) ?? requestID
        const payload = {
          confirmation_id: proof.id,
          message_id: proof.message_id,
          run_id: run,
          action_id: action,
          decision,
          mode,
          request_id: request,
          owner_token: proof.owner_token,
          generation: proof.generation,
          lease_until: now + ttl(),
        }
        if (found) {
          if (found.status === "delivering" && typeof prior.lease_until === "number" && prior.lease_until >= now) return
          return tx
            .update(SessionEventOutboxTable)
            .set({ status: "delivering", payload, updated_at: now, error: null })
            .where(and(eq(SessionEventOutboxTable.id, found.id), eq(SessionEventOutboxTable.status, found.status)))
            .returning()
            .get()
        }
        return tx
          .insert(SessionEventOutboxTable)
          .values({
            id: `outbox_${proof.id}`,
            session_id: sessionID,
            target_session_id: sessionID,
            kind: "task_confirmation",
            dedupe_key: key,
            status: "delivering",
            payload,
            created_at: now,
            updated_at: now,
            delivered_at: null,
            acked_at: null,
            error: null,
          })
          .returning()
          .get()
      },
      { behavior: "immediate" },
    )
    if (outbox?.status === "delivered" || outbox?.status === "acked") return
    if (!outbox) throw new ConflictError({ message: `Task continuation is already leased: ${proof.id}` })
    try {
      if (!rec(outbox.payload)) throw new ConflictError({ message: `Task delivery proof is invalid: ${proof.id}` })
      const mode = outbox.payload.mode
      beat?.guard()
      if (outbox.payload.request_id)
        await Question.reply({
          requestID: QuestionID.make(String(outbox.payload.request_id)),
          answers: [[decision === "confirm" ? "Confirm" : "Cancel"]],
          response: decision,
          guard: () => right(proof, outbox.id, "prompt"),
          rerouted: true,
        })
      if (mode === "prompt") {
        const existing = await MessageV2.get({ sessionID, messageID: proof.message_id }).catch(() => undefined)
        beat?.guard()
        if (existing) await SessionPrompt.loop({ sessionID, messageID: proof.message_id })
        if (!existing)
          await SessionPrompt.prompt({
            sessionID,
            messageID: proof.message_id,
            metadata: { internal: true, source: "task_confirmation", run_id: run },
            parts: [
              {
                type: "text",
                text:
                  decision === "confirm"
                    ? `User confirmed protocol action ${action} from run ${run}. Continue from the persisted assignment proof.`
                    : `User cancelled protocol action ${action} from run ${run}. Do not execute dependent work.`,
              },
            ],
          })
      }
      fence(proof)
      const delivered = Database.transaction(
        (db) => {
          const valid = db
            .select({ id: TaskConfirmationTable.id })
            .from(TaskConfirmationTable)
            .where(
              and(
                eq(TaskConfirmationTable.id, proof.id),
                owned(proof.owner_token),
                eq(TaskConfirmationTable.generation, proof.generation),
                gt(TaskConfirmationTable.lease_until, Date.now()),
              ),
            )
            .get()
          if (!valid) return
          const current = db
            .select()
            .from(SessionEventOutboxTable)
            .where(eq(SessionEventOutboxTable.id, outbox.id))
            .get()
          const meta = rec(current?.payload) ? current.payload : {}
          if (
            current?.status !== "delivering" ||
            meta.owner_token !== proof.owner_token ||
            meta.generation !== proof.generation ||
            meta.mode !== mode
          )
            return
          return db
            .update(SessionEventOutboxTable)
            .set({ status: "delivered", delivered_at: Date.now(), updated_at: Date.now(), error: null })
            .where(
              and(
                eq(SessionEventOutboxTable.id, outbox.id),
                eq(SessionEventOutboxTable.status, "delivering"),
                eq(SessionEventOutboxTable.payload, current.payload),
              ),
            )
            .returning({ id: SessionEventOutboxTable.id })
            .get()
        },
        { behavior: "immediate" },
      )
      fence(proof)
      if (!delivered) throw new ConflictError({ message: `Task continuation lease was lost: ${proof.id}` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      Database.use((db) => {
        const current = db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.id, outbox.id)).get()
        const meta = rec(current?.payload) ? current.payload : {}
        if (
          current?.status === "delivering" &&
          meta.owner_token === proof.owner_token &&
          meta.generation === proof.generation
        )
          db.update(SessionEventOutboxTable)
            .set({ status: "failed", error: message, updated_at: Date.now() })
            .where(
              and(
                eq(SessionEventOutboxTable.id, outbox.id),
                eq(SessionEventOutboxTable.status, "delivering"),
                eq(SessionEventOutboxTable.payload, current.payload),
              ),
            )
            .run()
        db.update(TaskConfirmationTable)
          .set({ status: "failed", error: message, time_updated: Date.now() })
          .where(
            and(
              eq(TaskConfirmationTable.id, proof.id),
              owned(proof.owner_token),
              eq(TaskConfirmationTable.generation, proof.generation),
              gt(TaskConfirmationTable.lease_until, Date.now()),
            ),
          )
          .run()
      })
      throw new ConflictError({ message: `Task continuation failed: ${message}` })
    }
  }

  function right(proof: typeof TaskConfirmationTable.$inferSelect, id: string, mode: "question" | "prompt") {
    return Database.transaction(
      (db) => {
        const valid = db
          .select({ id: TaskConfirmationTable.id })
          .from(TaskConfirmationTable)
          .where(
            and(
              eq(TaskConfirmationTable.id, proof.id),
              owned(proof.owner_token),
              eq(TaskConfirmationTable.generation, proof.generation),
              gt(TaskConfirmationTable.lease_until, Date.now()),
            ),
          )
          .get()
        if (!valid) return false
        const row = db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.id, id)).get()
        const payload = rec(row?.payload) ? row.payload : {}
        return (
          row?.status === "delivering" &&
          payload.owner_token === proof.owner_token &&
          payload.generation === proof.generation &&
          payload.mode === mode &&
          typeof payload.lease_until === "number" &&
          payload.lease_until > Date.now()
        )
      },
      { behavior: "immediate" },
    )
  }

  async function legacy(
    input: Parameters<typeof respond>[0],
    item: Record<string, unknown>,
    snapshot: Record<string, unknown>,
    run: string,
    action: string,
    title: string,
    plan: string,
    message: string,
  ) {
    const response = item.response
    if (response !== input.action)
      throw new ConflictError({ message: `Task terminal decision proof is invalid: ${input.proposalID}` })
    const intent = rec(snapshot.intent) ? snapshot.intent : {}
    const proof = await SessionAssignment.bySource({ sessionID: input.sessionID, runID: run, actionID: action })
    const assignment = input.action === "confirm" ? proof : undefined
    const saved = rec(item.assignment) ? text(item.assignment.id) : undefined
    if (input.action === "cancel" && (proof || saved))
      throw new ConflictError({ message: `Task cancelled assignment proof is invalid: ${input.proposalID}` })
    if (input.action === "confirm") {
      const content = assignment ? await SessionAssignment.content(assignment.id) : undefined
      const body = rec(content) ? content : {}
      const route = rec(body.assignment) ? body.assignment : {}
      const source = rec(body.source) ? body.source : {}
      if (
        !assignment ||
        saved !== assignment.id ||
        assignment.source_type !== "confirm" ||
        assignment.source_session_id !== input.sessionID ||
        assignment.source_message_id !== message ||
        assignment.source_run_id !== run ||
        assignment.source_action_id !== action ||
        assignment.title !== title ||
        assignment.target !== intent.target ||
        body.plan !== plan ||
        route.op !== intent.op ||
        route.target !== intent.target ||
        source.session_id !== input.sessionID ||
        source.message_id !== message ||
        source.run_id !== run ||
        source.action_id !== action
      )
        throw new ConflictError({ message: `Task terminal assignment proof is invalid: ${input.proposalID}` })
    }
    const canonical =
      input.op === "handoff"
        ? SessionTaskHandoff.locate({
            sourceID: input.sessionID,
            messageID: MessageID.make(message),
            runID: run,
            actionID: action,
            title,
            body: plan,
          })
        : undefined
    const handoff =
      input.op === "handoff" && input.handoffID ? await SessionTaskHandoff.get(input.handoffID) : undefined
    if (
      input.op === "handoff" &&
      (!canonical ||
        !handoff ||
        canonical.id !== handoff.id ||
        handoff.source_session_id !== input.sessionID ||
        handoff.source_message_id !== message ||
        (input.action === "confirm"
          ? !["confirmed", "creating", "started"].includes(handoff.status)
          : handoff.status !== "cancelled"))
    )
      throw new ConflictError({ message: `Task terminal handoff proof is invalid: ${input.proposalID}` })
    return {
      assignment,
      handoff,
      result: {
        proposal_id: input.proposalID,
        action: input.action,
        assignment_id: assignment?.id,
        status: input.op === "update" && input.action === "confirm" ? "revising" : handoff?.status,
        target_session_id: handoff?.target_session_id ?? undefined,
        target_task_id: handoff?.target_task_id ?? undefined,
      },
    }
  }

  function claim(input: {
    sessionID: SessionID
    proposalID: string
    action: Action
    op: "update" | "handoff"
    revisionID?: string
    handoffID?: string
    run: string
    actionID: string
    snapshot: Record<string, unknown>
    hash: string
    handoff?: Pick<SessionTaskHandoff.Info, "id" | "context_refs">
    imported?: Awaited<ReturnType<typeof legacy>>
  }) {
    return Database.transaction(
      (tx) => {
        const session = tx
          .select({ id: SessionTable.id, ctx: SessionTable.dsl_context })
          .from(SessionTable)
          .where(
            and(
              eq(SessionTable.id, input.sessionID),
              eq(SessionTable.project_id, Instance.project.id),
              eq(SessionTable.directory, Instance.directory),
            ),
          )
          .get()
        if (!session) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const ctx = rec(session.ctx) ? session.ctx : {}
        const protocol = rec(ctx.protocol) ? ctx.protocol : {}
        const vals = Array.isArray(protocol.confirmations) ? protocol.confirmations : []
        const proposal = vals.filter(
          (item) => rec(item) && item.run_id === input.run && item.action_id === input.actionID,
        )
        if (
          proposal.length !== 1 ||
          !rec(proposal[0]) ||
          digest(snap(input.sessionID, proposal[0], input.handoff)) !== input.hash
        )
          throw new ConflictError({ message: `Task proposal is not current: ${input.proposalID}` })
        if (input.imported) {
          const assignment = rec(proposal[0].assignment) ? text(proposal[0].assignment.id) : undefined
          const status = input.action === "confirm" ? "confirmed" : "cancelled"
          if (
            proposal[0].status !== status ||
            proposal[0].response !== input.action ||
            assignment !== input.imported.assignment?.id
          )
            throw new ConflictError({ message: `Task terminal proof changed: ${input.proposalID}` })
        }
        const found = tx
          .select()
          .from(TaskConfirmationTable)
          .where(
            and(
              eq(TaskConfirmationTable.session_id, input.sessionID),
              eq(TaskConfirmationTable.proposal_id, input.proposalID),
            ),
          )
          .get()
        if (found) {
          if (
            found.decision !== input.action ||
            found.operation !== input.op ||
            found.expected_revision_id !== (input.revisionID ?? null) ||
            found.handoff_id !== (input.handoffID ?? null) ||
            digest(found.snapshot) !== found.snapshot_hash ||
            found.snapshot_hash !== input.hash
          )
            throw new ConflictError({ message: `Task proposal decision conflicts: ${input.proposalID}` })
          if (found.status === "completed" || found.status === "cancelled") return { row: found, owner: false }
          if (input.op === "update") {
            const task = tx
              .select({ revision: SessionTaskTable.current_revision_id })
              .from(SessionTaskTable)
              .where(eq(SessionTaskTable.session_id, input.sessionID))
              .get()
            if (!task || task.revision !== input.revisionID)
              throw new ConflictError({ message: `Task revision is no longer current: ${input.revisionID}` })
          }
          if (
            found.status === "failed" ||
            ((found.status === "claimed" || found.status === "continuation_pending") && found.lease_until < Date.now())
          ) {
            const token = crypto.randomUUID()
            const saved = tx
              .update(TaskConfirmationTable)
              .set({
                status: "claimed",
                owner_token: token,
                generation: found.generation + 1,
                lease_until: Date.now() + ttl(),
                error: null,
                time_updated: Date.now(),
              })
              .where(
                and(
                  eq(TaskConfirmationTable.id, found.id),
                  eq(TaskConfirmationTable.status, found.status),
                  eq(TaskConfirmationTable.generation, found.generation),
                  owned(found.owner_token),
                ),
              )
              .returning()
              .get()
            if (saved) return { row: saved, owner: true }
          }
          return { row: found, owner: false }
        }
        if (input.op === "update" && !input.imported) {
          const task = tx
            .select({ revision: SessionTaskTable.current_revision_id })
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.session_id, input.sessionID))
            .get()
          if (!task) throw new NotFoundError({ message: `Task not found for session: ${input.sessionID}` })
          if (!input.revisionID || task.revision !== input.revisionID)
            throw new ConflictError({ message: `Task revision is no longer current: ${input.revisionID}` })
        }
        const now = Date.now()
        const token = crypto.randomUUID()
        if (input.imported) {
          const assignment = input.imported.assignment
            ? tx.select().from(AssignmentTable).where(eq(AssignmentTable.id, input.imported.assignment.id)).get()
            : undefined
          if (
            input.imported.assignment &&
            (!assignment ||
              assignment.source_session_id !== input.sessionID ||
              assignment.source_run_id !== input.run ||
              assignment.source_action_id !== input.actionID ||
              assignment.content_ref !== input.imported.assignment.content_ref ||
              assignment.content_hash !== input.imported.assignment.content_hash ||
              assignment.content_version !== input.imported.assignment.content_version)
          )
            throw new ConflictError({ message: `Task assignment proof changed: ${input.proposalID}` })
          const handoff = input.imported.handoff
            ? tx.select().from(TaskHandoffTable).where(eq(TaskHandoffTable.id, input.imported.handoff.id)).get()
            : undefined
          if (
            input.imported.handoff &&
            (!handoff ||
              handoff.source_session_id !== input.imported.handoff.source_session_id ||
              handoff.source_message_id !== input.imported.handoff.source_message_id ||
              handoff.dedupe_key !== input.imported.handoff.dedupe_key ||
              handoff.title !== input.imported.handoff.title ||
              handoff.body !== input.imported.handoff.body ||
              handoff.body_hash !== input.imported.handoff.body_hash ||
              JSON.stringify(handoff.context_refs) !== JSON.stringify(input.imported.handoff.context_refs) ||
              handoff.status !== input.imported.handoff.status ||
              handoff.target_session_id !== input.imported.handoff.target_session_id ||
              handoff.target_task_id !== input.imported.handoff.target_task_id)
          )
            throw new ConflictError({ message: `Task handoff proof changed: ${input.proposalID}` })
          return {
            row: tx
              .insert(TaskConfirmationTable)
              .values({
                id: `confirmation_${new Bun.CryptoHasher("sha256").update(`${input.sessionID}:${input.proposalID}`).digest("hex").slice(0, 24)}`,
                session_id: input.sessionID,
                proposal_id: input.proposalID,
                operation: input.op,
                decision: input.action,
                status: input.action === "confirm" ? "completed" : "cancelled",
                expected_revision_id: input.revisionID ?? null,
                handoff_id: input.handoffID ?? null,
                assignment_id: input.imported.assignment?.id ?? null,
                message_id: MessageID.make(
                  `msg_${new Bun.CryptoHasher("sha256").update(`continuation:${input.sessionID}:${input.proposalID}`).digest("hex").slice(0, 26)}`,
                ),
                owner_token: token,
                generation: 1,
                lease_until: 0,
                snapshot: input.snapshot,
                snapshot_hash: input.hash,
                result: input.imported.result,
                error: null,
                time_created: now,
                time_updated: now,
              })
              .returning()
              .get(),
            owner: false,
          }
        }
        return {
          row: tx
            .insert(TaskConfirmationTable)
            .values({
              id: `confirmation_${new Bun.CryptoHasher("sha256").update(`${input.sessionID}:${input.proposalID}`).digest("hex").slice(0, 24)}`,
              session_id: input.sessionID,
              proposal_id: input.proposalID,
              operation: input.op,
              decision: input.action,
              status: "claimed",
              expected_revision_id: input.revisionID ?? null,
              handoff_id: input.handoffID ?? null,
              assignment_id: null,
              message_id: MessageID.make(
                `msg_${new Bun.CryptoHasher("sha256").update(`continuation:${input.sessionID}:${input.proposalID}`).digest("hex").slice(0, 26)}`,
              ),
              owner_token: token,
              generation: 1,
              lease_until: now + ttl(),
              snapshot: input.snapshot,
              snapshot_hash: input.hash,
              result: null,
              error: null,
              time_created: now,
              time_updated: now,
            })
            .returning()
            .get(),
          owner: true,
        }
      },
      { behavior: "immediate" },
    )
  }

  async function settled(row: typeof TaskConfirmationTable.$inferSelect) {
    for (let count = 0; count < 100; count++) {
      const found = Database.use((db) =>
        db.select().from(TaskConfirmationTable).where(eq(TaskConfirmationTable.id, row.id)).get(),
      )
      if (found?.status === "completed" || found?.status === "cancelled") return found
      if (found?.status === "failed") throw new ConflictError({ message: found.error ?? "Task continuation failed" })
      await Bun.sleep(25)
    }
    throw new ConflictError({ message: `Task proposal is still processing: ${row.proposal_id}` })
  }
}
