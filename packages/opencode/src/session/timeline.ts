import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "@/snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "@/util/log"
import { PermissionNext } from "@/permission/next"

export namespace SessionTimeline {
  const log = Log.create({ service: "session.timeline" })

  export const Checkpoint = z.object({
    hash: z.string(),
    timestamp: z.number(),
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
    permission: PermissionNext.Ruleset.optional(),
    dsl_context: z.record(z.string(), z.unknown()).optional(),
  })
  export type Checkpoint = z.infer<typeof Checkpoint>

  export async function list(sessionID: SessionID): Promise<Checkpoint[]> {
    const msgs = await Session.messages({ sessionID })
    const checkpoints: Checkpoint[] = []

    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type === "step-start" && part.snapshot) {
          checkpoints.push({
            hash: part.snapshot,
            timestamp: msg.info.time.created,
            messageID: msg.info.id,
            partID: part.id,
            permission: part.permission,
            dsl_context: part.dsl_context,
          })
        }
      }
    }

    return checkpoints
  }

  export async function restore(sessionID: SessionID, hash: string) {
    log.info("restore", { sessionID, hash })
    const session = await Session.get(sessionID)

    // Find the checkpoint with this hash to get permission and dsl_context
    const checkpoints = await list(sessionID)
    const checkpoint = checkpoints.find((c) => c.hash === hash)

    // Restore filesystem from snapshot
    await Snapshot.restore(hash)

    // Restore permission grants and dsl_context if they were saved at checkpoint
    if (checkpoint) {
      if (checkpoint.permission !== undefined) {
        await Session.setPermission({
          sessionID,
          permission: checkpoint.permission,
        })
      }
      if (checkpoint.dsl_context !== undefined) {
        await Session.setDslContext({
          sessionID,
          dsl_context: checkpoint.dsl_context,
        })
      }
    }

    // Return updated session
    return Session.get(sessionID)
  }
}
