import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { AgentDelegation } from "@/agent/delegation"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = ctx?.agent
    ? AgentDelegation.list(await Agent.list(), ctx.agent.name)
    : AgentDelegation.list(await Agent.list(), "")

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      if (!AgentDelegation.visible(agent, ctx.agent)) throw new Error(`Agent ${params.subagent_type} is not available from ${ctx.agent}`)
      const meta = await AgentDelegation.meta(agent.name).catch(() => undefined)
      const gate = AgentDelegation.runtime({
        agent: agent.name,
        meta,
        action: {
          id: params.task_id ?? Identifier.ascending("tool"),
          title: params.description,
          operation: "task",
          executor: { type: "agent", target: agent.name, capabilities: [] },
          input: { prompt: params.prompt },
        },
      })
      await ctx.metadata({
        title: params.description,
        metadata: {
          metadata: gate,
        },
      })
      if (gate.status !== "ready") {
        return {
          title: params.description,
          metadata: data({
            blocked: true,
            metadata: gate,
          }),
          output: [
            `Task blocked by agent metadata control-plane: ${agent.name}`,
            `status: ${gate.status}`,
            gate.input.missing_inputs.length ? `missing_inputs: ${gate.input.missing_inputs.join(", ")}` : "",
            gate.collaboration.items.length ? `collaboration_plan: ${gate.collaboration.items.map((item) => `${item.edge_kind}:${item.target}`).join(", ")}` : "",
            gate.fallback ? `fallback_assignment: ${gate.fallback.target}` : "",
            gate.boundary.candidates.length ? `boundary: ${gate.boundary.candidates.map((item) => `${item.resource}.${item.action}:${item.status}`).join(", ")}` : "",
          ].filter((item) => item.length > 0).join("\n"),
        }
      }

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: agent.permission,
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          ...data({
            blocked: false,
            sessionId: session.id,
            model,
            agentSnapshot: gate.snapshot,
            observability: gate.observability,
          }),
        },
      })

      const messageID = MessageID.ascending()

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      })

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: data({
          blocked: false,
          metadata: gate,
          sessionId: session.id,
          model,
        }),
        output,
      }
    },
  }
})

function data(input: Record<string, unknown>) {
  return input
}
