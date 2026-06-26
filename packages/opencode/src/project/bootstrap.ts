import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcherService } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { VcsService } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { runPromiseInstance } from "@/effect/runtime"
import { SessionDelegation } from "@/session/delegation"
import { SessionRecovery } from "@/session/recovery"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  ShareNext.init()
  await Format.init()
  await LSP.init()
  await runPromiseInstance(FileWatcherService.use((service) => service.init()))
  File.init()
  await runPromiseInstance(VcsService.use((s) => s.init()))
  Snapshot.init()
  Truncate.init()
  const restored = await SessionStatus.restore()
  SessionDelegation.init()
  const packets = await SessionRecovery.mark().catch((err) => {
    Log.Default.warn("session recovery scan failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  })
  const stale = new Set(packets.map((item) => item.session_id))
  for (const [id, status] of Object.entries(restored)) {
    const sessionID = id as SessionID
    if (!revive(status, stale.has(sessionID))) continue
    SessionStatus.set(sessionID, { type: "running" })
    void SessionPrompt.loop({ sessionID }).catch((err) => {
      Log.Default.warn("session auto-continue failed", {
        sessionID: id,
        error: err instanceof Error ? err.message : String(err),
      })
      SessionStatus.set(sessionID, { type: "error", message: err instanceof Error ? err.message : String(err) })
    })
  }

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}

export function revive(status: SessionStatus.Info, stale: boolean) {
  if (SessionStatus.shouldContinue(status)) return true
  if (status.type !== "interrupted") return false
  if (status.prior !== "running" && status.prior !== "starting") return false
  return !stale
}
