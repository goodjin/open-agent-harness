import { Question } from "@/question"
import { Instance } from "@/project/instance"
import { and, ConflictError, Database, eq, ForbiddenError, inArray, lt, ne, NotFoundError, or } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { Session } from "."
import { SessionAssignment } from "./assignment"
import { SessionTaskHandoff } from "./task-handoff"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"
import { SessionPrompt } from "./prompt"
import { SessionEventOutboxTable, SessionTable, SessionTaskTable, TaskConfirmationTable } from "./session.sql"

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
    const claimed = claim({
      sessionID: input.sessionID,
      proposalID: input.proposalID,
      action: input.action,
      op: input.op,
      revisionID: input.revisionID,
      handoffID: input.handoffID,
      run,
      actionID: action,
      snapshot: JSON.stringify(item),
    })
    const proof = claimed.owner ? claimed.row : await settled(claimed.row)

    const handoff = input.handoffID ? await SessionTaskHandoff.get(input.handoffID) : undefined
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
    const status = input.action === "confirm" ? "confirmed" : "cancelled"
    if (item.status === status || proof.status === "completed" || proof.status === "cancelled") {
      const saved = proof.assignment_id ?? (rec(item.assignment) ? text(item.assignment.id) : undefined)
      return {
        proposal_id: input.proposalID,
        action: input.action,
        assignment_id: saved,
        status: handoff?.status,
        target_session_id: handoff?.target_session_id ?? undefined,
        target_task_id: handoff?.target_task_id ?? undefined,
      }
    }

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
    if (assignment && !proof.assignment_id)
      Database.use((db) =>
        db
          .update(TaskConfirmationTable)
          .set({ assignment_id: assignment.id, status: "continuation_pending", time_updated: Date.now() })
          .where(eq(TaskConfirmationTable.id, proof.id))
          .run(),
      )
    const transfer =
      assignment && handoff
        ? await safe(SessionTaskHandoff.confirm(handoff.id, { assignmentID: assignment.id }))
        : input.action === "cancel" && handoff
          ? await safe(SessionTaskHandoff.cancel(handoff.id))
          : undefined
    if (input.action === "cancel" && handoff && transfer?.status !== "cancelled")
      throw new ConflictError({ message: `Task handoff could not be cancelled: ${handoff.id}` })
    const now = Date.now()
    const next = vals.map((value) => {
      if (!rec(value) || value.run_id !== run || value.action_id !== action) return value
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
        response: input.action,
        status,
        updated_at: now,
      }
    })

    const live = (await Question.list()).find(
      (request) =>
        request.sessionID === input.sessionID &&
        request.tool?.messageID === message &&
        request.tool.callID === `call_${action}`,
    )
    if (live)
      await Question.reply({
        requestID: live.id,
        answers: [[input.action === "confirm" ? "Confirm" : "Cancel"]],
        response: input.action,
      })
    if (!live) await deliver(proof, input.sessionID, run, action, input.action)
    const saved = next.find((value) => rec(value) && value.run_id === run && value.action_id === action)
    if (saved) await Storage.write(["session_protocol_confirmation", input.sessionID, run, action], saved)
    await Session.setDslContext({
      sessionID: input.sessionID,
      dsl_context: { ...ctx, protocol: { ...protocol, confirmations: next } },
    })
    Database.use((db) =>
      db
        .update(TaskConfirmationTable)
        .set({ status: input.action === "confirm" ? "completed" : "cancelled", error: null, time_updated: Date.now() })
        .where(eq(TaskConfirmationTable.id, proof.id))
        .run(),
    )
    return {
      proposal_id: input.proposalID,
      action: input.action,
      assignment_id: assignment?.id,
      status: transfer?.status,
      target_session_id: transfer?.target_session_id ?? undefined,
      target_task_id: transfer?.target_task_id ?? undefined,
    }
  }

  export async function scan() {
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
    return Promise.all(
      rows.map((row) =>
        respond({
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
  }

  function rec(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
  }

  function text(input: unknown) {
    return typeof input === "string" ? input : undefined
  }

  function owner(sessionID: SessionID, run: string, action: string) {
    return Database.transaction(
      (db) =>
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
      { behavior: "immediate" },
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

  async function deliver(
    proof: typeof TaskConfirmationTable.$inferSelect,
    sessionID: SessionID,
    run: string,
    action: string,
    decision: Action,
  ) {
    const key = `task_confirmation:${proof.id}`
    const now = Date.now()
    Database.transaction(
      (tx) => {
        const found = tx.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.dedupe_key, key)).get()
        if (found) return
        tx.insert(SessionEventOutboxTable)
          .values({
            id: `outbox_${proof.id}`,
            session_id: sessionID,
            target_session_id: sessionID,
            kind: "task_confirmation",
            dedupe_key: key,
            status: "pending",
            payload: {
              confirmation_id: proof.id,
              message_id: proof.message_id,
              run_id: run,
              action_id: action,
              decision,
            },
            created_at: now,
            updated_at: now,
            delivered_at: null,
            acked_at: null,
            error: null,
          })
          .run()
      },
      { behavior: "immediate" },
    )
    const outbox = Database.use((db) =>
      db.select().from(SessionEventOutboxTable).where(eq(SessionEventOutboxTable.dedupe_key, key)).get(),
    )
    if (outbox?.status === "delivered" || outbox?.status === "acked") return
    try {
      const existing = await MessageV2.get({ sessionID, messageID: proof.message_id }).catch(() => undefined)
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
      Database.use((db) =>
        db
          .update(SessionEventOutboxTable)
          .set({ status: "delivered", delivered_at: Date.now(), updated_at: Date.now(), error: null })
          .where(eq(SessionEventOutboxTable.dedupe_key, key))
          .run(),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      Database.use((db) => {
        db.update(SessionEventOutboxTable)
          .set({ status: "failed", error: message, updated_at: Date.now() })
          .where(eq(SessionEventOutboxTable.dedupe_key, key))
          .run()
        db.update(TaskConfirmationTable)
          .set({ status: "failed", error: message, time_updated: Date.now() })
          .where(eq(TaskConfirmationTable.id, proof.id))
          .run()
      })
      throw new ConflictError({ message: `Task continuation failed: ${message}` })
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
    snapshot: string
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
        if (proposal.length !== 1 || JSON.stringify(proposal[0]) !== input.snapshot)
          throw new ConflictError({ message: `Task proposal is not current: ${input.proposalID}` })
        if (input.op === "update") {
          const task = tx
            .select({ revision: SessionTaskTable.current_revision_id })
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.session_id, input.sessionID))
            .get()
          if (!task) throw new NotFoundError({ message: `Task not found for session: ${input.sessionID}` })
          if (!input.revisionID || task.revision !== input.revisionID)
            throw new ConflictError({ message: `Task revision is no longer current: ${input.revisionID}` })
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
            found.expected_revision_id !== (input.revisionID ?? null)
          )
            throw new ConflictError({ message: `Task proposal decision conflicts: ${input.proposalID}` })
          if (
            found.status === "failed" ||
            ((found.status === "claimed" || found.status === "continuation_pending") &&
              found.time_updated < Date.now() - 30_000)
          ) {
            const saved = tx
              .update(TaskConfirmationTable)
              .set({ status: "claimed", error: null, time_updated: Date.now() })
              .where(and(eq(TaskConfirmationTable.id, found.id), eq(TaskConfirmationTable.status, found.status)))
              .returning()
              .get()
            if (saved) return { row: saved, owner: true }
          }
          return { row: found, owner: false }
        }
        const now = Date.now()
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
