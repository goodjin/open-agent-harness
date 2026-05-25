import z from "zod"
import { asSchema, jsonSchema, tool, type Tool as AITool, type ToolCallOptions } from "ai"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Metrics } from "@/observability/metrics"
import { Trace } from "@/observability/trace"
import { ModelID } from "@/provider/schema"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { PartID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncation"
import { PermissionNext } from "@/permission/next"
import { ProtocolToolCatalog } from "@/protocol/tool-catalog"

type McpResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; data: string }
    | {
        type: "resource"
        resource: {
          uri: string
          text?: string
          blob?: string
          mimeType?: string
        }
      }
  )[]
  metadata?: Record<string, unknown>
}

export namespace RuntimeTools {
  export type Info = Awaited<ReturnType<typeof build>>

  export async function build(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }) {
    const tools: Record<string, AITool> = {}
    const catalog: { id: string; description: string; schema: unknown }[] = []
    const agent = {
      ...input.agent,
      permission: input.agent.permission ?? [],
    }
    const ctx = (args: unknown, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: Record<string, unknown> }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args as Record<string, unknown>,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          workspaceID: input.session.workspaceID,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(agent.permission, input.session.permission ?? []),
        })
      },
    })

    const add = (id: string, description: string, schema: unknown, execute: (args: unknown, options: ToolCallOptions) => Promise<unknown>) => {
      if (input.tools?.[id] === false) return
      catalog.push({ id, description: ProtocolToolCatalog.describe({ id, description }), schema })
      tools[id] = tool({
        id: id as never,
        description,
        inputSchema: jsonSchema(schema as never),
        execute,
      })
    }

    const disabled = PermissionNext.disabled(
      (await ToolRegistry.ids()),
      PermissionNext.merge(agent.permission, input.session.permission ?? []),
    )
    for (const item of await ToolRegistry.tools(
      { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
      agent,
    )) {
      if (disabled.has(item.id)) continue
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      add(item.id, item.description, schema, async (args, options) => {
        const context = ctx(args, options)
        const start = Date.now()
        const span = Trace.begin("tool.call", { tool: item.id, sessionID: input.session.id })
        const result = await item.execute(args, context).then(
          (value) => {
            Metrics.emit("opencode_tool_call_total", { tool: item.id, status: "completed" })
            Metrics.time("opencode_tool_call_duration_ms", { tool: item.id, status: "completed" }, start)
            return value
          },
          (err: unknown) => {
            Metrics.emit("opencode_tool_call_total", { tool: item.id, status: "error" })
            Metrics.time("opencode_tool_call_duration_ms", { tool: item.id, status: "error" }, start)
            throw err
          },
        ).finally(() => Trace.end(span.id))
        return {
          ...result,
          attachments: result.attachments?.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: context.sessionID,
            messageID: input.processor.message.id,
          })),
        }
      })
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue
      if (input.tools?.[key] === false) continue

      const schema = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema)
      add(key, item.description ?? "", schema, async (args, options) => {
        const context = ctx(args, options)
        await context.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const start = Date.now()
        const span = Trace.begin("tool.call", { tool: key, sessionID: input.session.id })
        const result = await (execute(args, options) as Promise<McpResult>).then(
          (value) => {
            Metrics.emit("opencode_tool_call_total", { tool: key, status: "completed" })
            Metrics.time("opencode_tool_call_duration_ms", { tool: key, status: "completed" }, start)
            return value
          },
          (err: unknown) => {
            Metrics.emit("opencode_tool_call_total", { tool: key, status: "error" })
            Metrics.time("opencode_tool_call_duration_ms", { tool: key, status: "error" }, start)
            throw err
          },
        ).finally(() => Trace.end(span.id))

        const text: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
        for (const part of result.content) {
          if (part.type === "text") text.push(part.text)
          if (part.type === "image") {
            attachments.push({
              type: "file",
              mime: part.mimeType,
              url: `data:${part.mimeType};base64,${part.data}`,
            })
          }
          if (part.type === "resource") {
            if (part.resource.text) text.push(part.resource.text)
            if (part.resource.blob) {
              attachments.push({
                type: "file",
                mime: part.resource.mimeType ?? "application/octet-stream",
                url: `data:${part.resource.mimeType ?? "application/octet-stream"};base64,${part.resource.blob}`,
                filename: part.resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(text.join("\n\n"), {}, agent)
        return {
          title: "",
          metadata: {
            ...(result.metadata ?? {}),
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: context.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content,
        }
      })
    }

    return {
      tools,
      catalog,
      prompt: prompt(catalog),
      async execute(id: string, args: unknown, options: ToolCallOptions) {
        const found = tools[id]
        if (!found) throw new Error(`Tool '${id}' is not available.`)
        const execute = (found as { execute?: (args: unknown, options: ToolCallOptions) => Promise<unknown> }).execute
        if (!execute) throw new Error(`Tool '${id}' is not executable.`)
        return execute(args, options)
      },
    }
  }

  function prompt(catalog: { id: string; description: string; schema: unknown }[]) {
    const tools = catalog
      .map((item) =>
        [
          `## ${item.id}`,
          "",
          item.description.trim(),
          "",
          "input_schema:",
          "```json",
          JSON.stringify(item.schema, null, 2),
          "```",
        ].join("\n"),
      )
      .join("\n\n")
    return [
      "# Available Protocol Tools",
      "",
      "These are catalog entries for Agent Protocol DSL actions, not native/provider tools.",
      "The only native tool you can call is `AgentProtocolOutput`.",
      "To use one catalog entry, call `AgentProtocolOutput` exactly once and declare an action inside its input.",
      "For a tool action:",
      "- Set `executor.type` to `tool`.",
      "- Set `executor.target` to one tool id listed below.",
      "- Set `input` to the exact JSON argument object required by that tool schema.",
      "- Do not invent parameters outside the tool's input schema.",
      "- Do not use `target: \"auto\"` for tool actions.",
      "- Do not call listed tool ids directly as native/provider tools.",
      "",
      "Example:",
      "```json",
      '{ "type": "action", "id": "read_package", "title": "Read package manifest", "operation": "read", "executor": { "type": "tool", "target": "read", "capabilities": ["repo"] }, "input": { "filePath": "package.json" }, "depends_on": [], "context_refs": [], "result_policy": "summary" }',
      "```",
      "",
      tools,
    ].join("\n")
  }
}
