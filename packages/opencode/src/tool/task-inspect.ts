import z from "zod"
import { SessionTask } from "@/session/task"
import { Tool } from "./tool"

export const TaskInspectTool = Tool.define("task_inspect", {
  description: "Inspect the current session task. Summary is compact; workflow and results are loaded only when requested.",
  parameters: z.object({ include: z.enum(["summary", "workflow", "results"]).default("summary") }).strict(),
  async execute(input, ctx) {
    const task = await SessionTask.inspect(ctx.sessionID, input.include)
    if (!task)
      return {
        title: "No task bound",
        output: JSON.stringify({ status: "unbound" }),
        metadata: {} as { task_id?: string; revision_id?: string },
      }
    return {
      title: `${task.task.title} · v${task.revision.version}`,
      output: JSON.stringify(task, null, 2),
      metadata: { task_id: task.task.id, revision_id: task.revision.id },
    }
  },
})
