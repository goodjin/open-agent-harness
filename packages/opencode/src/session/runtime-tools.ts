import z from "zod"
import { asSchema, jsonSchema, tool, type Tool as AITool, type ToolCallOptions } from "ai"
import { Agent } from "@/agent/agent"
import { AgentDelegation } from "@/agent/delegation"
import { MCP } from "@/mcp"
import { Metrics } from "@/observability/metrics"
import { Trace } from "@/observability/trace"
import { ModelID } from "@/provider/schema"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session"
import { SessionDelegation } from "@/session/delegation"
import { MessageV2 } from "@/session/message-v2"
import { PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionStatus } from "@/session/status"
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

    if (delegating(agent)) {
      const desc = [
        "Query this parent session's delegated child task status from dsl_context.protocol.",
        "Use it only to inspect pending or completed delegated agent tasks before deciding the next Agent Protocol step.",
      ].join(" ")
      const schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          child_session_id: {
            type: "string",
            description: "Optional child session id to inspect.",
          },
          status: {
            type: "string",
            enum: ["pending", "completed", "partial", "blocked", "failed", "waiting_user"],
            description: "Optional status filter.",
          },
          include_output: {
            type: "boolean",
            description: "Include full child output. Defaults to false and returns summaries only.",
          },
        },
      }
      add("delegation_status", desc, schema, async (args) => {
        const req = object(args)
        const info = await SessionDelegation.query({
          sessionID: input.session.id,
          childID: text(req.child_session_id),
          status: status(req.status),
          output: req.include_output === true,
        })
        return {
          title: "Delegation status",
          metadata: info.counts,
          output: JSON.stringify(info, null, 2),
        }
      })

      add(
        "session_tree",
        "Return the current orchestration session tree with bounded session ids, parent ids, titles, agents, and runtime status fields.",
        {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async () => {
          const tree = await sessionTree(input.session.id)
          return {
            title: "Session tree",
            metadata: { sessions: tree.count },
            output: JSON.stringify(tree, null, 2),
          }
        },
      )

      add(
        "session_result",
        "Read progress and result details for one delegated child session under the current orchestration session.",
        {
          type: "object",
          additionalProperties: false,
          required: ["child_session_id"],
          properties: {
            child_session_id: {
              type: "string",
              description: "Child session id to inspect.",
            },
            include_messages: {
              type: "boolean",
              description: "Include recent child messages. Defaults to false.",
            },
            include_output: {
              type: "boolean",
              description: "Include full completed delegation output. Defaults to false.",
            },
          },
        },
        async (args) => {
          const req = object(args)
          const child = childID(req.child_session_id)
          await allowed(input.session.id, child)
          const info = await sessionResult(input.session.id, child, {
            messages: req.include_messages === true,
            output: req.include_output === true,
          })
          return {
            title: "Session result",
            metadata: { child_session_id: child },
            output: JSON.stringify(info, null, 2),
          }
        },
      )

      add(
        "session_continue",
        "Continue one delegated child session under the current orchestration session with an additional instruction.",
        {
          type: "object",
          additionalProperties: false,
          required: ["child_session_id", "prompt"],
          properties: {
            child_session_id: {
              type: "string",
              description: "Child session id to continue.",
            },
            prompt: {
              type: "string",
              description: "Instruction to append to the child session.",
            },
          },
        },
        async (args) => {
          const req = object(args)
          const child = childID(req.child_session_id)
          const prompt = required(req.prompt, "prompt")
          await allowed(input.session.id, child)
          const result = await continueSession(child, prompt)
          return {
            title: "Session continued",
            metadata: { child_session_id: child, message_id: result.info.id },
            output: JSON.stringify({
              child_session_id: child,
              status: SessionStatus.get(child),
              message_id: result.info.id,
              finish: result.info.role === "assistant" ? result.info.finish : undefined,
            }, null, 2),
          }
        },
      )
    }

    const visible = agent.name === "default" ? catalog.filter((item) => sessionTool(item.id)) : catalog
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

  function delegating(agent: Agent.Info) {
    if (agent.runner !== "protocol") return false
    return PermissionNext.trace("task", "*", agent.permission).rule.action === "allow"
  }

  function object(input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function text(input: unknown) {
    if (typeof input === "string") return input
  }

  function status(input: unknown): SessionDelegation.QueryStatus | undefined {
    if (
      input === "pending" ||
      input === "completed" ||
      input === "partial" ||
      input === "blocked" ||
      input === "failed" ||
      input === "waiting_user"
    ) return input
  }

  function sessionTool(id: string) {
    return id === "delegation_status" || id === "session_tree" || id === "session_result" || id === "session_continue"
  }

  async function agents(agent: Agent.Info) {
    return AgentDelegation.list(await Agent.list(), agent.name)
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
    const tree = catalog.find((item) => item.id === "session_tree")
    if (tree) {
      return [
        "Example:",
        "```json",
        '{ "kind": "act", "message": "I will inspect the orchestration tree.", "calls": [{ "id": "inspect_sessions", "type": "tool", "name": "session_tree", "args": {} }] }',
        "```",
        "",
      ].join("\n")
    }
    return ""
  }

  async function sessionTree(sessionID: Session.Info["id"]) {
    const root = await Session.get(sessionID)
    const descendants = await Session.descendants(sessionID)
    const sessions = [root, ...descendants]
    const rows = sessions.map((item) => ({
      id: item.id,
      parent_id: item.parentID,
      title: item.title,
      agent: agentOf(item),
      status: SessionStatus.get(item.id),
    }))
    const byParent = rows.reduce((acc, item) => {
      const key = item.parent_id ?? ""
      const list = acc.get(key)
      if (list) {
        list.push(item)
        return acc
      }
      acc.set(key, [item])
      return acc
    }, new Map<string, typeof rows>())
    type Node = typeof rows[number] & { children: Node[] }
    const node = (item: typeof rows[number]): Node => ({
      ...item,
      children: (byParent.get(item.id) ?? []).map(node),
    })
    return {
      root: node(rows[0]!),
      count: rows.length,
    }
  }

  async function sessionResult(parent: Session.Info["id"], child: Session.Info["id"], opts: { messages: boolean; output: boolean }) {
    const session = await Session.get(child)
    const delegations = await SessionDelegation.query({ sessionID: parent, childID: child, output: opts.output })
    const messages = opts.messages
      ? (await Session.messages({ sessionID: child, limit: 20 })).map((item) => ({
          id: item.info.id,
          role: item.info.role,
          agent: item.info.agent,
          finish: item.info.role === "assistant" ? item.info.finish : undefined,
          created_at: item.info.time.created,
          completed_at: item.info.role === "assistant" ? item.info.time.completed : undefined,
          text: item.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n").slice(0, 4000),
        }))
      : undefined
    return {
      session: {
        id: session.id,
        parent_id: session.parentID,
        title: session.title,
        agent: agentOf(session),
        status: SessionStatus.get(child),
        delegation: delegationOf(session),
      },
      delegations,
      ...(messages ? { messages } : {}),
    }
  }

  async function continueSession(child: Session.Info["id"], prompt: string) {
    const { SessionPrompt } = await import("./prompt")
    return SessionPrompt.prompt({
      sessionID: child,
      agent: agentOf(await Session.get(child)),
      parts: [{ type: "text", text: prompt }],
    })
  }

  async function allowed(parent: Session.Info["id"], child: Session.Info["id"]) {
    if (parent === child) return
    if ((await Session.descendants(parent)).some((item) => item.id === child)) return
    throw new Error(`Session ${child} is not a child of ${parent}.`)
  }

  function agentOf(session: Session.Info) {
    const found = text(object(object(object(session.dsl_context).protocol).delegation).agent)
    if (found) return found
    return "default"
  }

  function delegationOf(session: Session.Info) {
    const found = object(object(session.dsl_context).protocol).delegation
    if (!found || typeof found !== "object" || Array.isArray(found)) return undefined
    return found
  }

  function childID(input: unknown) {
    return SessionID.make(required(input, "child_session_id"))
  }

  function required(input: unknown, key: string) {
    if (typeof input === "string" && input.trim()) return input
    throw new Error(`Missing required field: ${key}`)
  }
}
