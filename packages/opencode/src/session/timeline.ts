import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "@/snapshot"
import { Session } from "."
import { Log } from "@/util/log"
import { PermissionNext } from "@/permission/next"
import { ForbiddenError } from "@/storage/db"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Audit } from "@/observability/audit"

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

  export const Preview = z.object({
    checkpoint: Checkpoint,
    files: z.string().array(),
    diff: z.string(),
  })
  export type Preview = z.infer<typeof Preview>

  export const Event = {
    Audit: BusEvent.define(
      "session.timeline.audit",
      z.object({
        type: z.literal("restore"),
        sessionID: SessionID.zod,
        hash: z.string(),
      }),
    ),
  }

  async function guard(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    if (session.directory !== Instance.directory) {
      throw new ForbiddenError({ message: `Session ${sessionID} does not belong to the current directory` })
    }
    return session
  }

  async function read(sessionID: SessionID): Promise<Checkpoint[]> {
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

  export async function list(sessionID: SessionID): Promise<Checkpoint[]> {
    await guard(sessionID)
    return read(sessionID)
  }

  async function checkpoint(sessionID: SessionID, hash: string) {
    await guard(sessionID)
    const item = (await read(sessionID)).find((checkpoint) => checkpoint.hash === hash)
    if (!item) throw new ForbiddenError({ message: `Checkpoint hash does not belong to session: ${hash}` })
    return item
  }

  export async function preview(sessionID: SessionID, hash: string): Promise<Preview> {
    log.info("preview", { sessionID, hash })
    const item = await checkpoint(sessionID, hash)
    const patch = await Snapshot.patch(hash)
    return {
      checkpoint: item,
      files: patch.files,
      diff: await Snapshot.diff(hash),
    }
  }

  export async function restore(sessionID: SessionID, hash: string) {
    log.info("restore", { sessionID, hash })
    const item = await checkpoint(sessionID, hash)
    await Snapshot.restore(hash)

    if (item.permission !== undefined) {
      await Session.setPermission({
        sessionID,
        permission: item.permission,
      })
    }
    if (item.dsl_context !== undefined) {
      await Session.setDslContext({
        sessionID,
        dsl_context: item.dsl_context,
      })
    }
    await Bus.publish(Event.Audit, {
      type: "restore",
      sessionID,
      hash,
    })
    const session = await Session.get(sessionID)
    await Audit.emit({
      sessionID,
      workspaceID: session.workspaceID,
      event: {
        type: "restore.completed",
        hash,
      },
    })

    return session
  }
}
