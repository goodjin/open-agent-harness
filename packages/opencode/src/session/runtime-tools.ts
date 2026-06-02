import z from "zod"
import { asSchema, jsonSchema, tool, type Tool as AITool, type ToolCallOptions } from "ai"
import { Agent } from "@/agent/agent"
import { AgentEntry } from "@/agent/entry"
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
      if (listed(id)) catalog.push({ id, description: ProtocolToolCatalog.describe({ id, description }), schema })
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

    const visible = agent.name === "default" ? [] : catalog
    return {
      tools,
      catalog: visible,
      prompt: prompt(visible, await agents(agent)),
      async execute(id: string, args: unknown, options: ToolCallOptions) {
        const found = tools[id]
        if (!found) throw new Error(`Tool '${id}' is not available.`)
        const execute = (found as { execute?: (args: unknown, options: ToolCallOptions) => Promise<unknown> }).execute
        if (!execute) throw new Error(`Tool '${id}' is not executable.`)
        return execute(args, options)
      },
    }
  }

  function listed(id: string) {
    return id !== "task"
  }

  async function agents(agent: Agent.Info) {
    return (await Agent.list())
      .filter((item) => AgentEntry.delegable(item))
      .filter((item) => !(agent.name === "default" && item.name === "default"))
      .map((item) => ({
        id: item.name,
        purpose: item.capability.purpose,
        tags: item.capability.tags,
        description: item.description,
      }))
  }

  function prompt(
    catalog: { id: string; description: string; schema: unknown }[],
    agents: { id: string; purpose: string; tags: string[]; description?: string }[],
  ) {
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
    if (catalog.length === 0) {
      return [
        "# Available Protocol Agents",
        "",
        "These are Agent Protocol delegation targets, not native/provider tools.",
        "The only native tool you can call is `AgentProtocolOutput`.",
        "To delegate work, call `AgentProtocolOutput` exactly once with `kind: \"act\"`.",
        "For an act package:",
        "- Use `calls` for all delegated runtime calls, even when there is only one call.",
        "- Set each call's `id` to a stable unique id.",
        "- Set each call's `type` to `agent`.",
        "- Set each call's `name` to one agent id listed below, or `auto` when no specific specialist fits.",
        "- Set each call's `args.prompt` to a bounded, self-contained task for that agent.",
        "- Shape each call as `{ id, type, name, args, depends, result }`.",
        "- Use `depends` only for real dependencies and omit it for independent calls that can run in parallel.",
        "- Use `result` for result policy.",
        "- Do not call repository tools directly from this agent. Delegate file reading, search, edits, commands, validation, and review to specialist agents.",
        "",
        "Example:",
        "```json",
        '{ "kind": "act", "message": "I will delegate focused frontend inspection.", "calls": [{ "id": "inspect_toolbar", "type": "agent", "name": "frontend", "args": { "prompt": "Inspect the toolbar button implementation and report likely causes." } }] }',
        "```",
        "",
        agents.length
          ? agents.map((item) => [
              `## ${item.id}`,
              "",
              `purpose: ${item.purpose}`,
              item.tags.length ? `tags: ${item.tags.join(", ")}` : "",
              item.description ?? "",
            ].filter((line) => line.length > 0).join("\n")).join("\n\n")
          : "No delegable agents are currently available.",
      ].join("\n")
    }
    return [
      "# Available Protocol Tools",
      "",
      "These are catalog entries for Agent Protocol DSL act packages, not native/provider tools.",
      "The only native tool you can call is `AgentProtocolOutput`.",
      "To use one catalog entry, call `AgentProtocolOutput` exactly once with `kind: \"act\"`.",
      "For an act package:",
      "- Use `calls` for all runtime calls, even when there is only one call.",
      "- Set each call's `id` to a stable unique id.",
      "- Set each call's `type` to `tool`.",
      "- Set each call's `name` to one tool id listed below.",
      "- Set each call's `args` to the exact JSON argument object required by that tool schema.",
      "- Shape each call as `{ id, type, name, args, depends, result }`.",
      "- Use `depends` for simple dependencies and `result` for result policy.",
      "- Do not invent parameters outside the tool's input schema.",
      "- Do not use `name: \"auto\"` for tool calls.",
      "- If a tool id is not listed below, it is unavailable for this agent.",
      "- If repository read, search, command, edit, validation, or review tools are not listed, delegate that work to a suitable agent instead of naming an unavailable tool.",
      "- Do not call listed tool ids directly as native/provider tools.",
      "- For delegation, do not use a tool call. Use `calls[].type: \"agent\"` with `name: \"auto\"` or a concrete agent id.",
      "",
      example(catalog),
      tools,
      "",
      "# Available Protocol Agents",
      "",
      "Use these with `calls[].type: \"agent\"`, not as tool names.",
      "For auto routing, set `name: \"auto\"` and put the goal in `args.prompt`; optional `args.subagent_type` can hint at the desired purpose.",
      "",
      agents.length
        ? agents.map((item) => [
            `## ${item.id}`,
            "",
            `purpose: ${item.purpose}`,
            item.tags.length ? `tags: ${item.tags.join(", ")}` : "",
            item.description ?? "",
          ].filter((line) => line.length > 0).join("\n")).join("\n\n")
        : "No delegable agents are currently available.",
    ].join("\n")
  }

  function example(catalog: { id: string }[]) {
    const read = catalog.find((item) => item.id === "read")
    if (read) {
      return [
        "Example:",
        "```json",
        '{ "kind": "act", "message": "I will read package.json.", "calls": [{ "id": "read_package", "type": "tool", "name": "read", "args": { "filePath": "package.json" } }] }',
        "```",
        "",
      ].join("\n")
    }
    const question = catalog.find((item) => item.id === "question")
    if (question) {
      return [
        "Example:",
        "```json",
        '{ "kind": "act", "message": "I need one clarification.", "calls": [{ "id": "ask_scope", "type": "tool", "name": "question", "args": { "questions": [{ "question": "Which scope should be planned first?", "header": "Scope", "options": [{ "label": "Current slice", "description": "Plan only the delegated slice." }, { "label": "Broader scope", "description": "Include adjacent work in the plan." }] }] } }] }',
        "```",
        "",
      ].join("\n")
    }
    return ""
  }
}
