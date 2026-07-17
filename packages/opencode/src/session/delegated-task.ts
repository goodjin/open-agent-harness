import type { AgentDelegation } from "@/agent/delegation"
import type { AgentProtocol } from "@/protocol/schema"
import { SessionAssignment } from "./assignment"
import { SessionLog } from "./log"
import type { MessageID, SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionTask } from "./task"

export namespace DelegatedTask {
  export async function bind(input: {
    action: AgentProtocol.Action
    agent: string
    childID: SessionID
    metadata?: ReturnType<typeof AgentDelegation.runtime>
    messageID: MessageID
    parentAgent: string
    parentID: SessionID
    plan?: string
    runID: string
  }) {
    const { SessionDelegation } = await import("./delegation")
    let assignment: SessionAssignment.Info | undefined
    try {
      await SessionDelegation.assign({
        action: input.action,
        agent: input.agent,
        childID: input.childID,
        metadata: input.metadata,
        messageID: input.messageID,
        parentAgent: input.parentAgent,
        runID: input.runID,
        sessionID: input.parentID,
      })
      assignment = await SessionAssignment.delegate({
        action: input.action,
        childID: input.childID,
        messageID: input.messageID,
        plan: input.plan,
        runID: input.runID,
        sessionID: input.parentID,
      })
      await SessionTask.beginDelegated({
        sessionID: input.childID,
        parentSessionID: input.parentID,
        parentRunID: input.runID,
        parentActionID: input.action.id,
        messageID: input.messageID,
      })
      return assignment
    } catch (err) {
      const saved =
        assignment ??
        (await SessionAssignment.bySource({
          sessionID: input.parentID,
          runID: input.runID,
          actionID: input.action.id,
        }))
      if (saved) {
        try {
          SessionAssignment.fail(saved.id)
        } catch (failure) {
          await log(input, failure)
        }
      }
      await SessionDelegation.fail({
        action: input.action,
        agent: input.agent,
        binding: true,
        childID: input.childID,
        error: err,
        messageID: input.messageID,
        parentAgent: input.parentAgent,
        parentID: input.parentID,
        runID: input.runID,
      }).catch((failure) => log(input, failure))
      try {
        SessionStatus.set(input.childID, { type: "failed", message: err instanceof Error ? err.message : String(err) })
        await SessionStatus.flush()
      } catch (failure) {
        await log(input, failure)
      }
      throw err
    }
  }

  async function log(
    input: { action: AgentProtocol.Action; childID: SessionID; messageID: MessageID; parentID: SessionID },
    err: unknown,
  ) {
    await SessionLog.emit({
      sessionID: input.parentID,
      messageID: input.messageID,
      level: "warn",
      type: "protocol.agent.binding.compensation_failed",
      data: { actionID: input.action.id, childSessionID: input.childID, error: String(err) },
    })
  }
}
