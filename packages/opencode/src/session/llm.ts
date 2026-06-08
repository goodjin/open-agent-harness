import { Installation } from "@/installation"
import { DEFAULT_REQUEST_TIMEOUT, Provider } from "@/provider/provider"
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
import { LLMConcurrency } from "./llm-concurrency"
import type { SessionID } from "./schema"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  export const PROTOCOL_OUTPUT_TOOL = "AgentProtocolOutput"
  const PROTOCOL_REMINDER = [
    "Final protocol reminder:",
    "Strictly follow the Agent Protocol output requirements for this request.",
    "Call `AgentProtocolOutput` exactly once.",
    "Use the current items shape only: `{ version: \"2\", items }`.",
    "Never wrap the protocol package in an `input` field; the native tool arguments themselves are exactly `{ version, items }`.",
    'For runtime work use `items`; common items are `{ id, kind: "tool", target, args, depends, result }`, `{ id, kind: "agent", target, prompt, depends, result }`, `{ id, kind: "ask", prompt, mode, options }`, and `{ id, kind: "confirm", prompt, plan }`.',
  ].join("\n")
  const PROTOCOL_TURN_REMINDER = [
    "Based on all turns above, decide the next step.",
    "Strictly follow the Agent Protocol output requirements for this request.",
  ].join("\n")
  const PROTOCOL = [
    "# Agent Protocol DSL v2",
    "",
    "You are running as a protocol runner. Do not call low-level tools directly for ordinary work.",
    "You have exactly one native tool available: `AgentProtocolOutput`.",
    "Call `AgentProtocolOutput` exactly once every assistant turn to submit the next protocol package.",
    "Every turn must end by making this native tool call. There are no exceptions.",
    'If you only need to answer the user, submit `{ "version": "2", "items": [{ "id": "answer", "kind": "answer", "message": "..." }] }`.',
    "",
    "The model-visible contract is the native `AgentProtocolOutput` tool schema.",
  ].join("\n")

  function deepseek(model: Provider.Model) {
    const id = `${model.providerID} ${model.api.id} ${model.family ?? ""}`.toLowerCase()
    return model.capabilities.reasoning && id.includes("deepseek")
  }

  function choice(input: StreamInput): ToolChoice<ToolSet> | undefined {
    if (input.agent.runner !== "protocol") return input.toolChoice
    if (deepseek(input.model)) return undefined
    return (input.toolChoice ?? { type: "tool", toolName: PROTOCOL_OUTPUT_TOOL }) as ToolChoice<ToolSet>
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: SessionID
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

  export type StreamOutput = StreamTextResult<ToolSet, unknown> & { release?: () => void; touch?: () => void }

  export function compose(
    input: Pick<StreamInput, "agent" | "model" | "system" | "user" | "runtimeTools" | "structuredOutput"> & {
      isCodex: boolean
    },
  ) {
    const protocol = input.agent.runner === "protocol" || input.structuredOutput === true
    const doc = input.agent.protocol?.prompt || PROTOCOL
    const prompt = protocol
      ? [input.agent.prompt, doc, input.runtimeTools?.prompt].filter((item) => item).join("\n\n")
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
      ...(input.agent.autoAppendPrompt ? [input.agent.autoAppendPrompt] : []),
    ].filter((x) => x)
    return [parts.join("\n")]
  }

  export async function stream(input: StreamInput): Promise<StreamOutput> {
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
    let release: (() => void) | undefined

    try {
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
      const timeout =
        options["timeout"] === false
          ? false
          : typeof options["timeout"] === "number"
            ? options["timeout"]
            : DEFAULT_REQUEST_TIMEOUT
      release = await LLMConcurrency.acquire({
        model: input.model,
        provider,
        sessionID: input.sessionID,
        abort: input.abort,
        timeout,
      })

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

      const tools: ToolSet =
        input.agent.runner === "protocol"
          ? {
              [PROTOCOL_OUTPUT_TOOL]: tool({
                description:
                  "Submit exactly one Agent Protocol package to the runtime. This is the only allowed tool for protocol-runner.",
                inputSchema: jsonSchema(
                  ProviderTransform.schema(input.model, AgentProtocol.OutputSchema as never) as never,
                ),
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
                  output: `Protocol violation: attempted to call native tool '${args.tool}'. Call '${PROTOCOL_OUTPUT_TOOL}' exactly once and put '${args.tool}' in an items[] entry with kind "tool", target "${args.tool}", and args matching that tool. ${args.error}`,
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
                if (input.agent.runner === "protocol" && deepseek(input.model)) {
                  delete (args.params as { toolChoice?: unknown }).toolChoice
                }
              }
              return args.params
            },
          },
        ],
      })

      const result = streamText({
        onError(error) {
          l.error("stream error", {
            error,
          })
        },
        async experimental_repairToolCall(failed) {
          if (input.agent.runner === "protocol" && failed.toolCall.toolName !== PROTOCOL_OUTPUT_TOOL) {
            const fixed = protocol(
              failed.toolCall.toolName,
              failed.toolCall.input,
              failed.error.message,
              input.runtimeTools,
            )
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
        toolChoice: choice(input),
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

      return Object.assign(result, { release })
    } catch (err) {
      release?.()
      throw err
    }
  }

  function protocol(tool: string, input: unknown, error: string, runtime: RuntimeTools.Info | undefined) {
    const name = tool.toLowerCase()
    const found = runtime?.catalog.find((item) => item.id === name)
    if (!found) return
    return {
      version: "2",
      items: [
        {
          id: `recovered_${safe(name)}`,
          kind: "tool",
          target: found.id,
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
    const rules = input.agent.inheritPermissions === true
      ? PermissionNext.merge(input.agent.permission, input.permission ?? [])
      : input.agent.permission
    const disabled = PermissionNext.disabled(
      Object.keys(input.tools),
      rules,
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
      if (/^\s*<turn\b/.test(text))
        return [
          { role: "user", content: text },
          { role: "user", content: PROTOCOL_TURN_REMINDER },
        ]
    }
    return messages
      .map(
        (item, idx): ModelMessage => ({
          role: "user",
          content: `<turn index="${idx + 1}">\n## ${heading(item.role)}\n\n${body(item)}\n</turn>`,
        }),
      )
      .concat({ role: "user", content: PROTOCOL_TURN_REMINDER } satisfies ModelMessage)
  }

  function heading(role: ModelMessage["role"]) {
    if (role === "user") return "User request"
    if (role === "assistant") return "Assistant message"
    if (role === "tool") return "Runtime result"
    return "System context"
  }

  function body(input: ModelMessage) {
    if (input.role !== "assistant") return content(input.content)
    const out = outputs(input.content)
    const thought = reasoning(input.content)
    if (out) return [thought, out].filter((item): item is string => Boolean(item)).join("\n")
    if (thought) return thought
    return "Assistant user-visible answer omitted from protocol context."
  }

  function content(input: ModelMessage["content"]) {
    if (typeof input === "string") return input
    if (!Array.isArray(input)) return JSON.stringify(input)
    return input
      .map((item) => {
        if ("type" in item && item.type === "text") return item.text
        const slimmed = slim(item)
        if (slimmed) return slimmed
        return JSON.stringify(item)
      })
      .join("\n")
  }

  function outputs(input: ModelMessage["content"]) {
    if (!Array.isArray(input)) return
    const out = input
      .map((item) => slim(item))
      .filter((item): item is string => Boolean(item))
      .join("\n")
    if (out) return out
  }

  function reasoning(input: ModelMessage["content"]) {
    if (!Array.isArray(input)) return
    const out = input
      .filter((item) => object(item).type === "reasoning")
      .flatMap((item) => {
        const data = object(item)
        return [typeof data.text === "string" ? data.text : undefined, ...texts(data.summary), ...texts(data.content)]
      })
      .filter((item): item is string => Boolean(item))
      .join("\n")
    if (out) return `Assistant reasoning:\n${out}`
  }

  function texts(input: unknown) {
    if (!Array.isArray(input)) return []
    return input
      .map((item) => object(item).text)
      .filter((item): item is string => typeof item === "string" && item.length > 0)
  }

  function slim(input: unknown) {
    const item = object(input)
    const type = typeof item.type === "string" ? item.type : ""
    const tool = typeof item.toolName === "string" ? item.toolName : type.startsWith("tool-") ? type.slice(5) : ""
    if (tool.toLowerCase() !== PROTOCOL_OUTPUT_TOOL.toLowerCase()) return
    const data = object(item.input)
    const kind = typeof data.kind === "string" ? data.kind : "unknown"
    if (kind === "act") {
      return `Protocol output: ${JSON.stringify({
        kind,
        calls: Array.isArray(data.calls) ? data.calls : [],
      })}`
    }
    return `Protocol output: kind=${kind} (message omitted; already shown to user).`
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
