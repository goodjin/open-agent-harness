import { Question } from "@/question"
import { Instance } from "@/project/instance"
import { and, ConflictError, Database, eq, ForbiddenError, ne, NotFoundError } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { Session } from "."
import { SessionAssignment } from "./assignment"
import { SessionTaskHandoff } from "./task-handoff"
import { MessageID, SessionID } from "./schema"
import { SessionPrompt } from "./prompt"
import { SessionTable } from "./session.sql"

export namespace SessionTaskConfirmation {
  export type Action = "confirm" | "cancel"

  export async function respond(input: {
    sessionID: SessionID
    proposalID: string
    action: Action
    op: "update" | "handoff"
    handoffID?: string
  }) {
    using guard = await Lock.write(`task-confirmation:${input.proposalID}`)
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

    const handoff = input.handoffID ? await SessionTaskHandoff.get(input.handoffID) : undefined
    if (input.op === "handoff" && !handoff)
      throw new NotFoundError({ message: `Task handoff not found: ${input.handoffID}` })
    if (handoff && handoff.source_session_id !== input.sessionID)
      throw new ForbiddenError({ message: `Task handoff does not belong to session: ${input.sessionID}` })
    if (handoff && input.action === "cancel" && handoff.status !== "proposed" && handoff.status !== "cancelled")
      throw new ConflictError({ message: `Task handoff is already ${handoff.status}: ${handoff.id}` })
    if (handoff?.status === "cancelled" && input.action === "confirm")
      throw new ConflictError({ message: `Task handoff is already cancelled: ${handoff.id}` })
    if (
      handoff &&
      (handoff.source_message_id !== message || handoff.title !== title || handoff.body !== plan)
    )
      throw new ConflictError({ message: `Task handoff proof is invalid: ${handoff.id}` })
    const status = input.action === "confirm" ? "confirmed" : "cancelled"
    if (item.status === status) {
      const saved = rec(item.assignment) ? text(item.assignment.id) : undefined
      return {
        proposal_id: input.proposalID,
        action: input.action,
        assignment_id: saved,
        status: handoff?.status,
        target_session_id: handoff?.target_session_id ?? undefined,
        target_task_id: handoff?.target_task_id ?? undefined,
      }
    }

    const assignment =
      input.action === "confirm"
        ? await safe(SessionAssignment.apply({
            actionID: action,
            assignment: intent,
            messageID: MessageID.make(message),
            plan,
            runID: run,
            sessionID: input.sessionID,
            title,
          }))
        : undefined
    if (input.action === "confirm" && !assignment)
      throw new ConflictError({ message: `Task proposal assignment is invalid: ${input.proposalID}` })
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
    if (!live)
      void SessionPrompt.prompt({
        sessionID: input.sessionID,
        metadata: { internal: true, source: "task_confirmation", run_id: run },
        parts: [
          {
            type: "text",
            text:
              input.action === "confirm"
                ? `User confirmed protocol action ${action} from run ${run}. Continue from the persisted assignment proof.`
                : `User cancelled protocol action ${action} from run ${run}. Do not execute dependent work.`,
          },
        ],
      }).catch(() => undefined)
    const saved = next.find((value) => rec(value) && value.run_id === run && value.action_id === action)
    if (saved) await Storage.write(["session_protocol_confirmation", input.sessionID, run, action], saved)
    await Session.setDslContext({
      sessionID: input.sessionID,
      dsl_context: { ...ctx, protocol: { ...protocol, confirmations: next } },
    })
    return {
      proposal_id: input.proposalID,
      action: input.action,
      assignment_id: assignment?.id,
      status: transfer?.status,
      target_session_id: transfer?.target_session_id ?? undefined,
      target_task_id: transfer?.target_task_id ?? undefined,
    }
  }

  function rec(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
  }

  function text(input: unknown) {
    return typeof input === "string" ? input : undefined
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
}
