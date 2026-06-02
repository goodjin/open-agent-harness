import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type ToolChoice,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import z from "zod"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import type { RuntimeTools } from "./runtime-tools"
import { AgentProtocol } from "@/protocol/schema"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  export const PROTOCOL_OUTPUT_TOOL = "AgentProtocolOutput"
  const PROTOCOL_REMINDER = [
    "Final protocol reminder:",
    "Strictly follow the Agent Protocol output requirements for this request.",
    "Call `AgentProtocolOutput` exactly once.",
    "Use the current flat shape only: `{ kind, message, calls }`.",
    "Never wrap the protocol package in an `input` field; the native tool arguments themselves are exactly `{ kind, message, calls }`.",
    "For runtime work use `kind: \"act\"` and a `calls` array; each call uses `{ id, type, name, args, depends, result }`.",
  ].join("\n")
  const PROTOCOL_TURN_REMINDER = [
    "Based on all turns above, decide the next step.",
    "Strictly follow the Agent Protocol output requirements for this request.",
  ].join("\n")
  const PROTOCOL = [
    "# Agent Protocol DSL v1",
    "",
    "You are running as a protocol runner. Do not call low-level tools directly for ordinary work.",
    "You have exactly one native tool available: `AgentProtocolOutput`.",
    "Call `AgentProtocolOutput` exactly once every assistant turn to submit the next flat protocol package.",
    "Every turn must end by making this native tool call. There are no exceptions.",
    "If you only need to answer the user, call `AgentProtocolOutput` with `kind: \"answer\"` and put the answer in `message`.",
    "",
    "Input contract:",
    "- Conversation input is a sequence of turns. Treat each `<turn role=\"...\">...</turn>` as one prior user, assistant, or runtime turn.",
    "- User turn input: ordinary user text, optionally with prior conversation context. It does not contain runtime results by itself.",
    "- Runtime turn input: a `<turn role=\"runtime\" source=\"agent-protocol\">...</turn>` contains structured Markdown observations produced by the protocol runtime.",
    "- Available tool input: the stable system prefix includes an `Available Protocol Tools` catalog. Use it to choose concrete tool ids and JSON argument schemas.",
    "- These input terms describe the conversation and tool catalog. They are not a field named `input` in the `AgentProtocolOutput` call.",
    "",
    "Decision rule:",
    "- Always reason from the input turns, then decide the next protocol kind yourself.",
    "- Use `kind: \"act\"` when runtime tool calls are needed: project inspection, file reads, command execution, summarization from repo state, code review, or edits.",
    "- Use `kind: \"answer\"` when you have enough information to show a user-facing answer.",
    "- Use `kind: \"done\"` only when the current turn is complete and there is no user-facing content to add.",
    "",
    "Output contract:",
    "- Do not write the protocol package as text, Markdown, XML, code fences, or provider-specific invocation syntax.",
    "- Submit the protocol package only by calling the native `AgentProtocolOutput` tool.",
    "- The native `AgentProtocolOutput` arguments are the flat protocol package itself: `{ kind, message, calls }`.",
    "- Never wrap the protocol package inside `{ input: ... }`, and never stringify the whole package into one field.",
    "- Never answer in plain text instead of calling `AgentProtocolOutput`.",
    "- Never print JSON for the protocol; JSON belongs only inside the native tool call arguments.",
    "- For runtime work, use `calls`: each item has required `id`, `type`, `name`, and optional `args`, `depends`, `result`, `title`.",
    "- A single tool call is still represented as a one-item `calls` array.",
    "- For `kind: \"answer\"` or `kind: \"done\"`, do not include `calls`; put user-visible Markdown in `message`.",
    "- You must never output fake tool output or fake runtime summaries.",
    "",
    "Forbidden output:",
    "- Provider-specific textual invocation syntax such as `minimax:tool_call`, `[TOOL_CALL]`, `tool_call`, XML invoke tags, or `tool =>`.",
    "- More than one `AgentProtocolOutput` call in a single assistant message.",
    "- Any tool result, runtime result, or final conclusion before the runtime has returned an observation.",
    "",
    "Flat field semantics:",
    "- `kind`: `act`, `answer`, or `done`.",
    "- `message`: user-visible Markdown for `answer` or `done`, or brief progress text for `act`.",
    "- `calls`: for `act`, an array of runtime calls.",
    "- `calls[].id`: required stable call id used by logs, graph nodes, and other calls' `depends` field.",
    "- `calls[].type`: `tool` or `agent`.",
    "- `calls[].name`: for `tool`, one concrete tool id from the Available Protocol Tools catalog; never use `auto`. For `agent`, use a concrete agent id or `auto`.",
    "- `calls[].args`: for `tool`, the exact JSON argument object required by the selected tool schema; for `agent`, the delegation input.",
    "- For subagent delegation, always use `type: \"agent\"`; do not use `type: \"tool\"` with `name: \"task\"`.",
    "- `depends`: optional call id or call id array that must finish first.",
    "- `result`: optional result policy: `summary`, `full`, `structured`, `on_failure`, `on_demand`, or `adaptive`; default is `summary`.",
    "",
    "Tool target requirements:",
    "- Use the Available Protocol Tools catalog below for tool ids, descriptions, and input schemas.",
    "- Choose concrete tool ids and arguments from the catalog; encode them only inside `calls`.",
    "- Do not invent tool names or parameters outside the listed schemas.",
    "- If a needed repository tool is not listed, it is unavailable for this agent; delegate that work to a suitable agent instead.",
    "",
    "Planning rules:",
    "- Do not create vague tool calls with `name: auto`; name the concrete tool and provide its `args`.",
    "- Use `calls` for every runtime action, even when there is only one call.",
    "- If you do not know exact files yet, use a listed discovery tool such as `glob` or `grep`; if no such tool is listed, delegate focused context gathering to an agent such as `explore`.",
    "- The runtime executes exactly what you declare. It will not infer project type, framework, file names, or search patterns from natural language.",
    "",
    "The model-visible contract is the native `AgentProtocolOutput` tool schema.",
  ].join("\n")

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    permission?: PermissionNext.Ruleset
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: ToolChoice<ToolSet>
    runtimeTools?: RuntimeTools.Info
    structuredOutput?: boolean
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export function compose(input: Pick<StreamInput, "agent" | "model" | "system" | "user" | "runtimeTools" | "structuredOutput"> & { isCodex: boolean }) {
    const protocol = input.agent.runner === "protocol" || input.structuredOutput === true
    const prompt = protocol
      ? [input.agent.prompt, PROTOCOL, input.runtimeTools?.prompt].filter((item) => item).join("\n\n")
      : input.agent.prompt
    const parts = [
      // use agent prompt otherwise provider prompt
      // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
      ...(prompt ? [prompt] : input.isCodex ? [] : SystemPrompt.provider(input.model)),
      // any custom prompt passed into this call
      ...input.system,
      // any custom prompt from last user message
      ...(input.user.system ? [input.user.system] : []),
      ...(protocol ? [PROTOCOL_REMINDER] : []),
    ].filter((x) => x)
    return [parts.join("\n")]
  }

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = compose({ ...input, isCodex })

    const header = system[0]
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      options,
    }

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const tools: ToolSet = input.agent.runner === "protocol"
      ? {
          [PROTOCOL_OUTPUT_TOOL]: tool({
            description: "Submit exactly one Agent Protocol package to the runtime. This is the only allowed tool for protocol-runner.",
            inputSchema: jsonSchema(ProviderTransform.schema(input.model, AgentProtocol.OutputSchema as never) as never),
            execute: async () => ({
              output: "Agent Protocol package received.",
              title: "Agent Protocol Output",
              metadata: { protocol: true },
            }),
          }),
          invalid: tool({
            description: "Internal protocol violation sink. Do not call.",
            inputSchema: z.object({
              tool: z.string(),
              error: z.string(),
            }),
            execute: async (args) => ({
              title: "Invalid Protocol Tool Call",
              output: `Protocol violation: attempted to call native tool '${args.tool}'. Call '${PROTOCOL_OUTPUT_TOOL}' exactly once and put '${args.tool}' in a calls[] item with type "tool", name "${args.tool}", and args matching that tool. ${args.error}`,
              metadata: { protocol: true, violation: "direct_tool_call", tool: args.tool },
            }),
          }),
        }
      : await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const model = wrapLanguageModel({
      model: language,
      middleware: [
        {
          async transformParams(args) {
            if (args.type === "stream" || args.type === "generate") {
              // @ts-expect-error
              args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
            }
            return args.params
          },
        },
      ],
    })

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        if (input.agent.runner === "protocol" && failed.toolCall.toolName !== PROTOCOL_OUTPUT_TOOL) {
          const fixed = protocol(failed.toolCall.toolName, failed.toolCall.input, failed.error.message, input.runtimeTools)
          if (fixed) {
            l.warn("recovering direct protocol tool call", {
              tool: failed.toolCall.toolName,
              repaired: PROTOCOL_OUTPUT_TOOL,
            })
            return {
              ...failed.toolCall,
              toolName: PROTOCOL_OUTPUT_TOOL,
              input: JSON.stringify(fixed),
            }
          }
        }
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.agent.runner === "protocol" ? (input.toolChoice ?? { type: "tool", toolName: PROTOCOL_OUTPUT_TOOL }) as ToolChoice<ToolSet> : input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...prepareMessages(input),
      ],
      model,
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  function protocol(tool: string, input: unknown, error: string, runtime: RuntimeTools.Info | undefined) {
    const name = tool.toLowerCase()
    const found = runtime?.catalog.find((item) => item.id === name)
    if (!found) return
    return {
      kind: "act",
      message: `Protocol violation recovered: the model attempted a direct \`${tool}\` native tool call. Converted it to an Agent Protocol action and continued.`,
      calls: [
        {
          id: `recovered_${safe(name)}`,
          type: "tool",
          name: found.id,
          title: `Recovered ${name}`,
          args: object(input),
          result: "summary",
        },
      ],
    }
  }

  function object(input: unknown): Record<string, unknown> {
    if (typeof input === "string") {
      try {
        const json = JSON.parse(input)
        if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>
      } catch {
        return {}
      }
      return {}
    }
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    return {}
  }

  function safe(input: string) {
    return input.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = PermissionNext.disabled(
      Object.keys(input.tools),
      PermissionNext.merge(input.agent.permission, input.permission ?? []),
    )
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  export function prepareMessages(input: Pick<StreamInput, "agent" | "messages">): ModelMessage[] {
    if (input.agent.runner !== "protocol") return input.messages
    return turns(input.messages)
  }

  function turns(messages: ModelMessage[]): ModelMessage[] {
    if (messages.length === 1) {
      const text = content(messages[0]!.content)
      if (/^\s*<turn\b/.test(text)) return [{ role: "user", content: text }, { role: "user", content: PROTOCOL_TURN_REMINDER }]
    }
    return messages.map((item, idx): ModelMessage => ({
      role: "user",
      content: `<turn index="${idx + 1}">\n## ${heading(item.role)}\n\n${content(item.content)}\n</turn>`,
    })).concat({ role: "user", content: PROTOCOL_TURN_REMINDER } satisfies ModelMessage)
  }

  function heading(role: ModelMessage["role"]) {
    if (role === "user") return "User request"
    if (role === "assistant") return "Assistant message"
    if (role === "tool") return "Runtime result"
    return "System context"
  }

  function content(input: ModelMessage["content"]) {
    if (typeof input === "string") return input
    if (!Array.isArray(input)) return JSON.stringify(input)
    return input
      .map((item) => {
        if ("type" in item && item.type === "text") return item.text
        return JSON.stringify(item)
      })
      .join("\n")
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
