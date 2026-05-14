import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "@/snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "@/util/log"

export namespace SessionTimeline {
  const log = Log.create({ service: "session.timeline" })

  export const Checkpoint = z.object({
    hash: z.string(),
    timestamp: z.number(),
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
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
          })
        }
      }
    }

    return checkpoints
  }

  export async function restore(sessionID: SessionID, hash: string) {
    log.info("restore", { sessionID, hash })
    const session = await Session.get(sessionID)
    await Snapshot.restore(hash)
    return session
  }
}
