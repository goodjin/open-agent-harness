import z from "zod"
import { SessionTask } from "@/session/task"
import { SessionDelegation } from "@/session/delegation"
import { SessionID } from "@/session/schema"
import { Tool } from "./tool"

const parameters = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("stop"), session_ids: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ action: z.literal("stop_all") }).strict(),
])

export const SessionControlTool = Tool.define("session_control", {
  description: "List or stop only child sessions in the current task revision update scope.",
  parameters,
  async execute(input, ctx) {
    const scope = await SessionTask.scope(ctx.sessionID)
    const ids =
      input.action === "stop" ? input.session_ids.map((item) => SessionID.make(item)) : scope.map((item) => item.session_id)
    const allowed = new Set(scope.map((item) => item.session_id))
    if (ids.some((id) => !allowed.has(id))) throw new SessionTask.Conflict("session_control_scope_violation")
    const selected = scope.filter((item) => ids.includes(item.session_id))
    if (input.action !== "list") {
      const runs = Map.groupBy(selected, (item) => item.run_id)
      for (const run of runs.keys()) {
        await SessionDelegation.stop({
          sessionID: ctx.sessionID,
          runID: run,
          childIDs: runs.get(run)!.map((item) => item.session_id),
          reason: "Stopped for confirmed task revision.",
        })
      }
    }
    const result = await SessionTask.scope(ctx.sessionID)
    return {
      title: input.action === "list" ? "Task child sessions" : "Task child sessions stopped",
      output: JSON.stringify(result, null, 2),
      metadata: { controlled: true, count: selected.length },
    }
  },
})
