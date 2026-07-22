import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelsDev } from "../../src/provider/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { BUILTIN_AGENTS } from "../../src/agent/builtin.generated"
import { TaskAdmission } from "../../src/protocol/task-admission"

const ent = {
  primary: true,
  delegable: true,
  mentionable: true,
  default: true,
  hidden: false,
}
const cap = {
  purpose: "test",
  tags: [],
  cost: "low",
  writes: true,
} satisfies Agent.Info["capability"]

describe("session.llm.hasToolCalls", () => {
  test("composes conditional task admission for every entry planner", () => {
    ;["default", "milestone-planner", "feature-planner"].forEach((id) => {
      const src = BUILTIN_AGENTS.find((item) => item.id === id)
      if (!src) throw new Error(`missing builtin planner: ${id}`)
      const agent = Agent.Info.parse({
        name: src.id,
        mode: id === "default" ? "primary" : "subagent",
        entry: src.meta.entry,
        capability: src.meta.capability,
        runner: src.meta.runner,
        permission: [],
        autoAppendPrompt: src.meta.auto_append_prompt,
        requestFooter: src.requestFooter,
        protocol: src.protocol,
        options: {},
        prompt: Agent.prompt(src),
      })
      const system = LLM.compose({
        agent,
        model: {} as never,
        system: [],
        user: {
          id: MessageID.make(`user-${id}-task-admission`),
          sessionID: SessionID.make(`session-${id}-task-admission`),
          role: "user",
          time: { created: Date.now() },
          agent: id,
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        } satisfies MessageV2.User,
        runtimeTools: {
          prompt: "# Available Protocol Tools\n\nRuntime catalog task admission.",
        } as never,
        isCodex: false,
      })[0]
      const final = [system, agent.requestFooter?.prompt].join("\n\n")

      expect(system.indexOf("# Rules")).toBeLessThan(system.indexOf("# Planner Protocol"))
      expect(system.indexOf("# Planner Protocol")).toBeLessThan(system.indexOf("# Available Protocol Tools"))
      expect(system.indexOf("# Available Protocol Tools")).toBeLessThan(system.indexOf("Final protocol reminder:"))
      expect(final.indexOf("Final protocol reminder:")).toBeLessThan(final.indexOf("Session Task Admission:"))
      expect(final).toContain("Ordinary conversation does not create or modify a Task")
      expect(final).toContain("Before preparing executable actions, read and follow Current Session Task")
      expect(final).toContain('assignment={"op":"create","target":"self"}')
      expect(final).toContain('assignment={"op":"update","target":"self"}')
      expect(final).toContain('assignment={"op":"handoff","target":"peer"}')
      expect(final).toContain("continue the current Revision without creating a second Task")
      expect(final).toContain("complete executable graph in the same package")
      expect(final).toContain("You own semantic routing")
      expect(final).toContain("Every newly declared executable action graph creates a new Run")
      expect(final).not.toContain(
        'After intent is clear and before starting execution work, use `{ id, kind: "confirm", prompt, plan, assignment: { op: "create", target: "self" } }`',
      )
      expect(final).not.toContain(
        'For direct user-originated execution graphs, clarify the request, complete applicable analysis, synthesize and review the structured handoff and route, then emit a final `kind: "confirm"` item whose `plan` contains the reviewed Markdown handoff and whose `assignment` metadata is `{ "op": "create", "target": "self" }`.',
      )
      expect(final).not.toContain('For direct user-originated graphs, emit a `kind: "confirm"` item')
    })
  })

  test("adds protocol instructions for default when configured as protocol runner", () => {
    const system = LLM.compose({
      agent: {
        name: "default",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        prompt: "Default agent prompt.",
        options: {},
        permission: [],
      } satisfies Agent.Info,
      model: {} as never,
      system: [],
      user: {
        id: MessageID.make("user-default-protocol-compose"),
        sessionID: SessionID.make("session-default-protocol-compose"),
        role: "user",
        time: { created: Date.now() },
        agent: "default",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      } satisfies MessageV2.User,
      runtimeTools: {
        prompt: "# Available Protocol Tools\n\n## read\ninput_schema:",
      } as never,
      isCodex: false,
    })[0]

    expect(system).toContain("Default agent prompt.")
    expect(system).toContain("Agent Protocol DSL v2")
    expect(system).toContain("AgentProtocolOutput")
    expect(system).toContain("The model-visible contract is the native `AgentProtocolOutput` tool schema.")
    expect(system).toContain("Final protocol reminder:")
  })

  test("adds protocol instructions for protocol runner even without agent prompt", () => {
    const system = LLM.compose({
      agent: {
        name: "protocol-runner",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        options: {},
        permission: [],
      } satisfies Agent.Info,
      model: {} as never,
      system: [],
      user: {
        id: MessageID.make("user-protocol-compose"),
        sessionID: SessionID.make("session-protocol-compose"),
        role: "user",
        time: { created: Date.now() },
        agent: "protocol-runner",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      } satisfies MessageV2.User,
      runtimeTools: {
        prompt: "# Available Protocol Tools\n\n## read\ninput_schema:",
      } as never,
      isCodex: false,
    })[0]

    expect(system).toContain("Agent Protocol DSL v2")
    expect(system).toContain("Do not call low-level tools directly")
    expect(system).toContain("AgentProtocolOutput")
    expect(system).toContain("Every turn must end by making this native tool call")
    expect(system).toContain('"kind": "answer"')
    expect(system).toContain("message")
    expect(system).toContain("Available Protocol Tools")
    expect(system).toContain("## read")
    expect(system).toContain("items")
    expect(system).toContain("kind")
    expect(system).toContain("target")
    expect(system).toContain("args")
    expect(system).toContain("depends")
    expect(system).toContain("result")
    expect(system).toContain("native `AgentProtocolOutput` tool schema")
    expect(system).toContain("Final protocol reminder:")
    expect(system).toContain("Never wrap the protocol package in an `input` field")
    expect(system.trim().endsWith(TaskAdmission.Prompt)).toBe(true)
    expect(system).not.toContain("AgentProtocolOutput.input.type")
    expect(system).not.toContain('"actions":')
    expect(system).not.toContain("executor")
    expect(system).not.toContain("tool/args")
    expect(system).not.toContain("say")
    expect(system).not.toContain("calls[].kind")
    expect(system).not.toContain("after")
  })

  test("does not hard-code grep as a protocol tool target", async () => {
    const prompt = await Bun.file(path.join(import.meta.dir, "../../config/protocol/agent-protocol-v2.md")).text()
    const system = LLM.compose({
      agent: {
        name: "protocol-runner",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        options: {},
        permission: [],
        protocol: {
          file: "agent-protocol-v2.md",
          prompt,
        },
      } satisfies Agent.Info,
      model: {} as never,
      system: [],
      user: {
        id: MessageID.make("user-protocol-no-grep-example"),
        sessionID: SessionID.make("session-protocol-no-grep-example"),
        role: "user",
        time: { created: Date.now() },
        agent: "protocol-runner",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      } satisfies MessageV2.User,
      runtimeTools: {
        prompt: "# Available Protocol Agents\n\nNo protocol tools are currently available.",
      } as never,
      isCodex: false,
    })[0]

    expect(system).not.toContain('"target": "grep"')
    expect(system).toContain('"target": "<listed-tool-id>"')
  })

  test("uses protocol prompt loaded from agent metadata", () => {
    const system = LLM.compose({
      agent: {
        name: "protocol-runner",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        options: {},
        permission: [],
        protocol: {
          file: "protocol.md",
          prompt: "# Custom Protocol Contract\n\nUse `items` for protocol actions.",
        },
      } satisfies Agent.Info,
      model: {} as never,
      system: [],
      user: {
        id: MessageID.make("user-protocol-doc-compose"),
        sessionID: SessionID.make("session-protocol-doc-compose"),
        role: "user",
        time: { created: Date.now() },
        agent: "protocol-runner",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      } satisfies MessageV2.User,
      runtimeTools: {
        prompt: "# Available Protocol Tools\n\n## read\ninput_schema:",
      } as never,
      isCodex: false,
    })[0]

    expect(system).toContain("# Custom Protocol Contract")
    expect(system).toContain("Use `items` for protocol actions.")
    expect(system).not.toContain("Agent Protocol DSL v1")
  })

  test("wraps protocol runner messages as conversation turns", () => {
    const messages = LLM.prepareMessages({
      agent: {
        name: "protocol-runner",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        options: {},
        permission: [],
      } satisfies Agent.Info,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello\nworld" }],
        },
      ],
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe("user")
    expect(messages[0]?.content).toContain('<turn index="1">')
    expect(messages[0]?.content).toContain("## User request")
    expect(messages[0]?.content).toContain("hello\nworld")
    expect(messages[1]?.content).toContain("Based on all turns above")
    expect(messages[1]?.content).not.toContain("<turn")
  })

  test("slims protocol output turns to keep actions and omit displayed answers", () => {
    const messages = LLM.prepareMessages({
      agent: {
        name: "protocol-runner",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        options: {},
        permission: [],
      } satisfies Agent.Info,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "answer",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input: {
                kind: "answer",
                message: "Large user-visible answer ".repeat(200),
              },
            },
          ],
        } as ModelMessage,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "act",
              toolName: LLM.PROTOCOL_OUTPUT_TOOL,
              input: {
                kind: "act",
                message: "Progress text that does not drive execution",
                calls: [
                  {
                    id: "inspect",
                    type: "tool",
                    name: "grep",
                    args: { pattern: "AgentProtocolOutput" },
                  },
                ],
              },
            },
          ],
        } as ModelMessage,
      ],
    })
    const text = messages.map((item) => String(item.content)).join("\n")

    expect(text).toContain("Protocol output: kind=answer")
    expect(text).not.toContain("Large user-visible answer")
    expect(text).not.toContain("Progress text that does not drive execution")
    expect(text).toContain('"kind":"act"')
    expect(text).toContain('"id":"inspect"')
    expect(text).toContain('"name":"grep"')
  })

  test("keeps stored protocol reasoning and omits displayed answers from assistant turns", () => {
    const messages = LLM.prepareMessages({
      agent: {
        name: "protocol-runner",
        mode: "primary",
        runner: "protocol",
        entry: ent,
        capability: cap,
        options: {},
        permission: [],
      } satisfies Agent.Info,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Internal protocol reasoning ".repeat(200),
            },
            {
              type: "text",
              text: "Large user-visible answer ".repeat(200),
            },
          ],
        } as ModelMessage,
      ],
    })
    const text = messages.map((item) => String(item.content)).join("\n")

    expect(text).toContain("Assistant reasoning:")
    expect(text).toContain("Internal protocol reasoning")
    expect(text).not.toContain("Large user-visible answer")
    expect(text).not.toContain("providerOptions")
  })

  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ path: string; response: Response; resolve: (value: Capture) => void }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createToolStream(input: Record<string, unknown>, name = "read") {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: { name, arguments: JSON.stringify(input) },
                },
              ],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          entry: ent,
          capability: cap,
          options: {},
          inheritPermissions: true,
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const tools = capture.body.tools as
          | Array<{ function?: { name?: string; parameters?: { type?: string; anyOf?: unknown } } }>
          | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("reports permission denial instead of repairing unavailable tools to invalid", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createToolStream({ filePath: "src/app.ts", content: "test" }, "write"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-permission-denied-tool")
        const agent = {
          name: "frontend",
          mode: "primary",
          entry: ent,
          capability: cap,
          options: {},
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "edit", pattern: "*", action: "deny" },
          ],
          inheritPermissions: false,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-permission-denied-tool"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "write the file" }],
          tools: {
            read: tool({
              description: "Read file",
              inputSchema: z.object({ filePath: z.string() }),
              execute: async () => ({ output: "" }),
            }),
            write: tool({
              description: "Write file",
              inputSchema: z.object({ filePath: z.string(), content: z.string() }),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const items: unknown[] = []
        for await (const item of stream.fullStream) {
          items.push(item)
        }
        const err = items.find(
          (item): item is { type: "tool-error"; toolName: string; error: unknown } =>
            !!item && typeof item === "object" && "type" in item && item.type === "tool-error",
        )
        expect(err?.toolName).toBe("write")
        expect(String(err?.error)).toContain("Permission denied for tool 'write'")
        expect(String(err?.error)).toContain("inherit_permissions: false")
        expect(JSON.stringify(items)).not.toContain('"toolName":"invalid"')

        const capture = await request
        expect(JSON.stringify(capture.body.tools)).not.toContain("invalid")
      },
    })
  })

  test("reports malformed ActionResult input without exposing invalid tool", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createToolStream({}, LLM.ACTION_RESULT_TOOL), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-action-result-malformed")
        const agent = {
          name: "verifier",
          mode: "subagent",
          kind: "verifier",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          inheritPermissions: false,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-action-result-malformed"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a verifier."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "submit result" }],
          tools: {},
        })

        const items: unknown[] = []
        for await (const item of stream.fullStream) {
          items.push(item)
        }
        const err = items.find(
          (item): item is { type: "tool-error"; toolName: string; error: unknown } =>
            !!item && typeof item === "object" && "type" in item && item.type === "tool-error",
        )
        expect(err?.toolName).toBe(LLM.ACTION_RESULT_TOOL)
        expect(String(err?.error)).toContain("ActionResult input schema/parse failed")
        expect(String(err?.error)).toContain("Retry by calling ActionResult again and follow this protocol exactly")
        expect(String(err?.error)).toContain("Do not wrap the arguments in input")
        expect(String(err?.error)).toContain("Worker result required fields: action_id, status, result.")
        expect(String(err?.error)).toContain("Status values for all results: success, failure, error, reply, skipped.")
        expect(String(err?.error)).toContain("Worker optional fields: scope, changed_files, verification, blockers.")
        expect(String(err?.error)).toContain(
          "Verifier result required fields: action_id, target_action_id, status, result.",
        )
        expect(String(err?.error)).toContain("Verifier optional fields: issues, evidence, worker_feedback.")
        expect(String(err?.error)).not.toContain('"result_type": "worker"')
        expect(String(err?.error)).not.toContain("unavailable tool 'invalid'")
        expect(JSON.stringify(items)).not.toContain('"toolName":"invalid"')

        await request
      },
    })
  })

  test("protocol runner exposes only AgentProtocolOutput as native tool", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-protocol-tool")
        const agent = {
          name: "protocol-runner",
          mode: "primary",
          runner: "protocol",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-protocol-tool"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            bash: tool({
              description: "Run command",
              inputSchema: z.object({ command: z.string() }),
              execute: async () => ({ output: "" }),
            }),
          },
          runtimeTools: {
            prompt: "# Available Protocol Tools\n\n## bash",
          } as never,
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const tools = capture.body.tools as
          | Array<{ function?: { name?: string; parameters?: { type?: string; anyOf?: unknown } } }>
          | undefined
        expect(tools?.map((item) => item.function?.name)).toEqual(["AgentProtocolOutput"])
        expect(tools?.[0]?.function?.parameters?.type).toBe("object")
        expect(tools?.[0]?.function?.parameters?.anyOf).toBeUndefined()
        expect(JSON.stringify(capture.body.tool_choice)).toContain("AgentProtocolOutput")
        expect(JSON.stringify(tools)).toContain("message")
        expect(JSON.stringify(tools)).toContain("depends")
        expect(JSON.stringify(tools)).toContain('"type"')
        expect(JSON.stringify(tools)).not.toContain("say")
        expect(JSON.stringify(tools)).not.toContain("after")
      },
    })
  })

  test("protocol runner does not force tool choice for DeepSeek thinking models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "deepseek"
    const modelID = "deepseek-reasoner"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-deepseek-protocol-tool")
        const agent = {
          name: "protocol-runner",
          mode: "primary",
          runner: "protocol",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-deepseek-protocol-tool"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            bash: tool({
              description: "Run command",
              inputSchema: z.object({ command: z.string() }),
              execute: async () => ({ output: "" }),
            }),
          },
          runtimeTools: {
            prompt: "# Available Protocol Tools\n\n## bash",
          } as never,
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.map((item) => item.function?.name)).toEqual(["AgentProtocolOutput"])
        expect(capture.body.tool_choice).toBeUndefined()
      },
    })
  })

  test("protocol runner repairs direct native tool calls into AgentProtocolOutput", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createToolStream({ filePath: "package.json" }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-protocol-repair")
        const agent = {
          name: "protocol-runner",
          mode: "primary",
          runner: "protocol",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-protocol-repair"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "read package" }],
          tools: {},
          runtimeTools: {
            prompt: "# Available Protocol Tools\n\n## read",
            catalog: [{ id: "read", description: "", schema: {} }],
          } as never,
        })

        const calls: unknown[] = []
        for await (const item of stream.fullStream) {
          if (item.type === "tool-call") calls.push(item.input)
        }

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.map((item) => item.function?.name)).toEqual(["AgentProtocolOutput"])
        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
          version: "2",
          items: [
            {
              id: "recovered_read",
              kind: "tool",
              target: "read",
              title: "Recovered read",
              args: { filePath: "package.json" },
              result: "summary",
            },
          ],
        })
      },
    })
  })

  test("protocol invalid output shows raw malformed AgentProtocolOutput", () => {
    const bad = '{"version": "2", "items": .'
    const result = LLM.invalid({
      tool: LLM.PROTOCOL_OUTPUT_TOOL,
      error: `Invalid input for tool AgentProtocolOutput: JSON parsing failed: Text: ${bad}. Error message: JSON Parse error: Unexpected EOF`,
    })

    expect(result.output).toContain("Raw protocol output:")
    expect(result.output).toContain(bad)
    expect(result.metadata.raw).toBe(bad)
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)
      },
    })
  })

  test("sends messages API payload for Anthropic models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "anthropic"
    const modelID = "claude-3-5-sonnet-20241022"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          entry: ent,
          capability: cap,
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})
