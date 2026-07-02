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
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncation"
import { PermissionNext } from "@/permission/next"
import { ProtocolToolCatalog } from "@/protocol/tool-catalog"
import { SessionResult } from "@/session/result"

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

const resumeInstructions = {
  format: [
    "The previous assistant output was interrupted or malformed.",
    "Continue from the last partial result and finish this delegated session in the expected format.",
    "If output format is constrained, keep the same schema and output the missing section directly.",
  ].join("\n"),
  error: [
    "The previous assistant run reached an error condition.",
    "Resume the delegated session, recover the task state, and continue to the expected next step.",
    "Keep recovery actionable and keep the same result format.",
  ].join("\n"),
  stopped: [
    "The previous assistant run stopped before it completed expected work.",
    "Continue from the last checkpoint and finish this delegated task immediately.",
    "Do not return a summary-only completion yet.",
  ].join("\n"),
  empty: [
    "The previous assistant run did not produce a usable final answer.",
    "Continue the delegated session and produce the expected result format.",
    "Do not repeat prior setup unless it is required to recover context.",
  ].join("\n"),
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
    const rules = Agent.permissions(agent, input.session.permission)
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
          ruleset: rules,
        })
      },
    })

    const add = (
      id: string,
      description: string,
      schema: unknown,
      execute: (args: unknown, options: ToolCallOptions) => Promise<unknown>,
    ) => {
      if (input.tools?.[id] === false) return
      if (listed(id)) catalog.push({ id, description: ProtocolToolCatalog.describe({ id, description }), schema })
      tools[id] = tool({
        id: id as never,
        description,
        inputSchema: jsonSchema(schema as never),
        execute,
      })
    }

    const disabled = PermissionNext.disabled(await ToolRegistry.ids(), rules)
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
        const result = await item
          .execute(args, context)
          .then(
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
          )
          .finally(() => Trace.end(span.id))
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
        const result = await (execute(args, options) as Promise<McpResult>)
          .then(
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
          )
          .finally(() => Trace.end(span.id))

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
            source: "mcp",
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
        "Return a compact natural-language summary of all sessions in the current orchestration tree, grouped by runtime status.",
        {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async () => {
          const tree = await sessionTree(input.session.id)
          return {
            title: "Session tree",
            metadata: { sessions: tree.count, status: tree.status },
            output: tree.output,
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
        "Continue delegated child sessions under the current orchestration session with additional instructions.",
        {
          type: "object",
          additionalProperties: false,
          required: ["prompt"],
          properties: {
            child_session_id: {
              type: "string",
              description: "Deprecated. Use child_session_ids for multi-session input.",
            },
            child_session_ids: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Optional list of child session ids to continue, processed in order.",
            },
            prompt: {
              type: "string",
              description: "Instruction to append to the child session.",
            },
          },
        },
        async (args) => {
          const req = object(args)
          const prompt = required(req.prompt, "prompt")
          const ids = await continueIDs(req, input.session.id)
          const results: ContinueResult[] = []
          for (const id of ids) {
            await SessionDelegation.mark({
              parentID: input.session.id,
              childID: id,
              messageID: input.processor.message.id,
              current: true,
            })
            results.push(...(await continueSessionTree(id, prompt)))
            await SessionDelegation.mark({
              parentID: input.session.id,
              childID: id,
              messageID: input.processor.message.id,
              current: false,
              status: SessionStatus.get(id).type,
            })
          }
          const latest = results.at(-1) ?? resultFromInput(input.session.id, prompt)
          return {
            title: "Session continued",
            metadata: {
              child_session_ids: ids,
              child_session_id: latest.child,
              reason: latest.reason,
              message_id: latest.message_id,
              status: latest.status,
              finish: latest.finish,
            },
            output: JSON.stringify(
              {
                kind: "session_continue_result",
                child_session_id: latest.child,
                reason: latest.reason,
                status: latest.status,
                message_id: latest.message_id,
                finish: latest.finish,
                reply: latest.reply,
                results,
              },
              null,
              2,
            ),
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
    )
      return input
  }

  function sessionTool(id: string) {
    return id === "delegation_status" || id === "session_tree" || id === "session_result" || id === "session_continue"
  }

  async function agents(agent: Agent.Info) {
    return AgentDelegation.list(await Agent.list(), agent.name).map((item) => ({
      id: item.name,
      kind: item.kind,
      purpose: item.capability.purpose,
      tags: item.capability.tags,
      description: item.description,
    }))
  }

  function prompt(
    catalog: { id: string; description: string; schema: unknown }[],
    agents: { id: string; kind?: string; purpose: string; tags: string[]; description?: string }[],
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
        'To delegate work, call `AgentProtocolOutput` exactly once with `{ version: "2", items }`.',
        "- Before delegating execution, confirm that the task is clear, internally consistent, and actionable.",
        "- If the task is ambiguous, incomplete, contradictory, or risky, ask the user first. Multi-turn clarification is allowed.",
        "- Use `items` for all delegated runtime actions, even when there is only one item.",
        "- Set each item's `id` to a stable unique id.",
        "- Set each item's `kind` to `agent`.",
        "- Set each item's `target` to one agent id listed below, or `auto` when no specific specialist fits.",
        "- Set each item's `prompt` to a bounded, self-contained task for that agent.",
        "- Shape each agent item as `{ id, kind, target, prompt, depends, result }`.",
        "- Use `depends` only for real dependencies and omit it for independent calls that can run in parallel.",
        "- Use `result` for result policy.",
        '- Use `items[].kind: "confirm"` with `{ id, kind, prompt, plan }` when a planner needs user approval before execution.',
        '- Assignment confirmation is not required for clarification or exploratory delegation. After intent is clear and before starting execution work, use `items[].kind: "confirm"` with `assignment: { "op": "create", "target": "self" }`; the confirm `plan` is the full assignment content for final user approval.',
        "- For every mutating worker task, also declare a matching verifier or reviewer task that depends on the worker result.",
        "- Verifier prompts must include acceptance criteria, expected worker output, and concrete commands or evidence to check when known.",
        "- Do not call repository tools directly from this agent. Delegate file reading, search, edits, commands, validation, and review to specialist agents.",
        "",
        "Example:",
        "```json",
        '{ "version": "2", "items": [{ "id": "inspect_toolbar", "kind": "agent", "target": "frontend", "prompt": "Inspect the toolbar button implementation and report likely causes." }] }',
        "```",
        "",
        agents.length
          ? agents
              .map((item) =>
                [
                  `## ${item.id}`,
                  "",
                  item.kind ? `kind: ${item.kind}` : "",
                  `purpose: ${item.purpose}`,
                  item.tags.length ? `tags: ${item.tags.join(", ")}` : "",
                  item.description ?? "",
                ]
                  .filter((line) => line.length > 0)
                  .join("\n"),
              )
              .join("\n\n")
          : "No delegable agents are currently available.",
      ].join("\n")
    }
    return [
      "# Available Protocol Tools",
      "",
      "These are catalog entries for Agent Protocol DSL v2 items, not native/provider tools.",
      "The only native tool you can call is `AgentProtocolOutput`.",
      'To use one catalog entry, call `AgentProtocolOutput` exactly once with `{ version: "2", items }`.',
      "- Before declaring runtime work, confirm that the task is clear, internally consistent, and actionable.",
      "- If requirements are ambiguous, incomplete, contradictory, or risky, ask the user first. Multi-turn clarification is allowed.",
      "- Use `items` for all runtime actions, even when there is only one item.",
      "- Set each item's `id` to a stable unique id.",
      "- Set each item's `kind` to `tool`.",
      "- Set each item's `target` to one tool id listed below.",
      "- Set each item's `args` to the exact JSON argument object required by that tool schema.",
      "- Shape each tool item as `{ id, kind, target, args, depends, result }`.",
      "- Use `depends` for simple dependencies and `result` for result policy.",
      "- Do not invent parameters outside the tool's input schema.",
      '- Do not use `target: "auto"` for tool items.',
      "- If a tool id is not listed below, it is unavailable for this agent.",
      "- If repository read, search, command, edit, validation, or review tools are not listed, delegate that work to a suitable agent instead of naming an unavailable tool.",
      "- Do not call listed tool ids directly as native/provider tools.",
      '- For delegation, do not use a tool item. Use `items[].kind: "agent"` with `target: "auto"` or a concrete agent id.',
      '- For user choices or additional information, use `items[].kind: "input"` with `{ id, kind, prompt, mode, options, fields }`; the runtime returns the answer to the model before more work is declared.',
      '- For plan approval, use `items[].kind: "confirm"` with `{ id, kind, prompt, plan }`; executable items should depend on that confirmation.',
      '- Assignment confirmation is not required for clarification or exploratory delegation. After intent is clear and before starting execution work, use `items[].kind: "confirm"` with `assignment: { "op": "create", "target": "self" }`; the confirm `plan` is the full assignment content for final user approval.',
      "- For every mutating worker task, also declare a matching verifier or reviewer task that depends on the worker result.",
      "- Verifier prompts must include acceptance criteria, expected worker output, and concrete commands or evidence to check when known.",
      "",
      example(catalog),
      tools,
      "",
      "# Available Protocol Agents",
      "",
      'Use these with `items[].kind: "agent"`, not as tool names.',
      'For auto routing, set `target: "auto"` and put the goal in `prompt`; optional `capabilities` can hint at the desired purpose.',
      "",
      agents.length
        ? agents
            .map((item) =>
              [
                `## ${item.id}`,
                "",
                item.kind ? `kind: ${item.kind}` : "",
                `purpose: ${item.purpose}`,
                item.tags.length ? `tags: ${item.tags.join(", ")}` : "",
                item.description ?? "",
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
            )
            .join("\n\n")
        : "No delegable agents are currently available.",
    ].join("\n")
  }

  function example(catalog: { id: string }[]) {
    const read = catalog.find((item) => item.id === "read")
    if (read) {
      return [
        "Example:",
        "```json",
        '{ "version": "2", "items": [{ "id": "read_package", "kind": "tool", "target": "read", "args": { "filePath": "package.json" } }] }',
        "```",
        "",
      ].join("\n")
    }
    const question = catalog.find((item) => item.id === "question")
    if (question) {
      return [
        "Example:",
        "```json",
        '{ "version": "2", "items": [{ "id": "choose_scope", "kind": "input", "prompt": "Which scope should be planned first?", "mode": "single", "options": [{ "id": "current", "label": "Current slice", "description": "Plan only the delegated slice. The user can add details after selecting it." }, { "id": "broader", "label": "Broader scope", "description": "Include adjacent work in the plan. The user can add details after selecting it." }] }] }',
        "```",
        "",
      ].join("\n")
    }
    const tree = catalog.find((item) => item.id === "session_tree")
    if (tree) {
      return [
        "Example:",
        "```json",
        '{ "version": "2", "items": [{ "id": "inspect_sessions", "kind": "tool", "target": "session_tree", "args": {} }] }',
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
      status: SessionStatus.get(item.id),
    }))
    const status = rows.reduce(
      (acc, item) => {
        acc[item.status.type] = (acc[item.status.type] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )
    const byStatus = rows.reduce((acc, item) => {
      const key = item.status.type
      const list = acc.get(key)
      if (list) {
        list.push(item)
        return acc
      }
      acc.set(key, [item])
      return acc
    }, new Map<string, typeof rows>())
    const lines = [
      `Session tree has ${rows.length} sessions.`,
      `Root session: ${root.id}.`,
      `Status counts: ${Object.entries(status)
        .map(([key, val]) => `${key}=${val}`)
        .join(", ")}.`,
      "",
      ...Array.from(byStatus.entries()).flatMap(([key, list]) => [
        `${key} (${list.length}):`,
        list
          .map((item) =>
            item.status.type === key && Object.keys(item.status).length === 1
              ? item.id
              : `${item.id} ${JSON.stringify(item.status)}`,
          )
          .join(", "),
        "",
      ]),
    ]
    return {
      count: rows.length,
      status,
      output: lines.join("\n").trim(),
    }
  }

  async function sessionResult(
    parent: Session.Info["id"],
    child: Session.Info["id"],
    opts: { messages: boolean; output: boolean },
  ) {
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
          text: item.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n\n")
            .slice(0, 4000),
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
      ...(await resultOf(session, opts.output)),
      delegations,
      ...(messages ? { messages } : {}),
    }
  }

  async function resultOf(session: Session.Info, output: boolean) {
    const found = object(session.dsl_context?.result)
    if (found.type !== "session.action_result") return {}
    const id = reqString(found.result_id)
    const parsed = id ? await SessionResult.parse(id) : undefined
    return {
      result: {
        ...found,
        ...(parsed?.action_result ? { action_result: parsed.action_result } : {}),
        ...(parsed?.protocol_result ? { protocol_result: parsed.protocol_result } : {}),
        ...(output && parsed?.output !== undefined ? { output: parsed.output } : {}),
      },
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

  type ContinueResult = {
    child: Session.Info["id"]
    message_id: MessageID
    status: SessionStatus.Info
    finish?: MessageV2.Assistant["finish"]
    reply: string
    reason: "normal" | "stopped" | "error" | "format" | "empty"
  }
  type Asst = MessageV2.WithParts & { info: MessageV2.Assistant }

  function resultFromInput(id: Session.Info["id"], input: string): ContinueResult {
    return {
      child: id,
      status: SessionStatus.get(id),
      message_id: MessageID.ascending(),
      reply: input,
      finish: "error",
      reason: "error",
    }
  }

  async function continueSessionTree(session: Session.Info["id"], prompt: string) {
    const done = await completedResult(session)
    if (done) return [done]

    const rows: ContinueResult[] = []
    const children = await childSessions(session)
    for (const child of children) {
      rows.push(...(await continueSessionTree(child.id, prompt)))
    }

    const resumed = await continueSelf(session, prompt)
    rows.push(resumed)
    return rows
  }

  async function continueIDs(input: Record<string, unknown>, parent: Session.Info["id"]) {
    const raw = reqArray(input.child_session_ids) ?? []
    const one = reqString(input.child_session_id)
    const list = raw.length > 0 ? raw : one ? [one] : []
    const ids = Array.from(new Set(list)).map((item) => childID(item))
    if (ids.length === 0) throw new Error(`Missing required field: child_session_id`)
    for (const id of ids) {
      await allowed(parent, id)
    }
    return ids
  }

  async function childSessions(parent: Session.Info["id"]) {
    return (await Session.descendants(parent)).filter((item) => item.parentID === parent)
  }

  async function completedResult(session: Session.Info["id"]): Promise<ContinueResult | undefined> {
    const msg = await latestResult(session)
    if (!msg) return
    return {
      child: session,
      message_id: msg.info.id,
      status: SessionStatus.get(session),
      finish: msg.info.finish,
      reply: assistantText(msg) || "No textual reply was produced from the child session.",
      reason: "normal" as const,
    }
  }

  async function continueSelf(session: Session.Info["id"], prompt: string): Promise<ContinueResult> {
    const status = SessionStatus.get(session)
    if (stopped(status.type)) {
      const resumed = await resumeSession(session)
      return formatResult(session, resumed, "stopped")
    }

    const last = await latestAssistant(session)
    const kind = interruption(last)
    const next = await continueSession(session, continuationPrompt(prompt, kind))
    return formatResult(session, next, kind)
  }

  function interruption(input: Asst | undefined) {
    if (!input) return "empty" as const
    if (input.info.error !== undefined) return "error" as const
    if (input.info.finish === "error") return "error" as const

    const text = assistantText(input)
    if (!text && (typeof input.info.finish !== "string" || !["tool-calls", "unknown"].includes(input.info.finish))) {
      return "format" as const
    }

    return "normal"
  }

  function continuationPrompt(input: string, reason: ContinueResult["reason"]) {
    const base = reason === "normal" ? input : (resumeInstructions[reason] ?? resumeInstructions.format)
    if (reason === "normal") return base
    return [base, "", input].join("\n")
  }

  async function resumeSession(session: Session.Info["id"]) {
    const { SessionPrompt } = await import("./prompt")
    try {
      return await SessionPrompt.loop({
        sessionID: session,
        resume_existing: true,
      })
    } catch {
      return continueSession(session, "The previous run was interrupted and should continue from the last state.")
    }
  }

  async function latestAssistant(session: Session.Info["id"]): Promise<Asst | undefined> {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(session)).catch(() => [])
    return msgs
      .flatMap((item) =>
        item.info.role === "assistant" && typeof item.info.time.completed === "number" ? [item as Asst] : [],
      )
      .at(0)
  }

  async function latestResult(session: Session.Info["id"]): Promise<Asst | undefined> {
    const msg = await latestAssistant(session)
    if (!msg || msg.info.error) return
    if (!msg.info.finish || ["tool-calls", "unknown"].includes(msg.info.finish)) return
    return msg
  }

  function stopped(input: SessionStatus.Info["type"]) {
    return (
      input === "aborted" ||
      input === "paused" ||
      input === "failed" ||
      input === "timeout" ||
      input === "error" ||
      input === "blocked"
    )
  }

  function formatResult(
    session: Session.Info["id"],
    result: MessageV2.WithParts,
    reason: ContinueResult["reason"],
  ): ContinueResult {
    return {
      child: session,
      status: SessionStatus.get(session),
      message_id: result.info.id,
      finish: result.info.role === "assistant" ? result.info.finish : undefined,
      reply: assistantText(result) || "No textual reply was produced from the child session.",
      reason,
    }
  }

  function reqString(input: unknown) {
    if (typeof input === "string" && input.trim()) return input
  }

  function reqArray(input: unknown) {
    if (!Array.isArray(input)) return
    return input.flatMap((item) => {
      if (typeof item !== "string" || !item.trim()) return []
      return [item]
    })
  }

  async function allowed(parent: Session.Info["id"], child: Session.Info["id"]) {
    if (parent === child) return
    if ((await Session.descendants(parent)).some((item) => item.id === child)) return
    throw new Error(`Session ${child} is not a child of ${parent}.`)
  }

  function agentOf(session: Session.Info) {
    return session.agent ?? "default"
  }

  function delegationOf(session: Session.Info) {
    const found = object(object(session.dsl_context).protocol).delegation
    if (!found || typeof found !== "object" || Array.isArray(found)) return undefined
    return found
  }

  function childID(input: unknown) {
    return SessionID.make(required(input, "child_session_id"))
  }

  function assistantText(result: MessageV2.WithParts) {
    return result.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
  }

  function required(input: unknown, key: string) {
    if (typeof input === "string" && input.trim()) return input
    throw new Error(`Missing required field: ${key}`)
  }
}
