import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { SessionStatus } from "../../src/session/status"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

const model = {
  id: ModelID.make("test"),
  providerID: ProviderID.make("test"),
  api: {
    npm: "test",
  },
  cost: {
    input: 0,
    output: 0,
  },
  limit: {
    context: 100_000,
    output: 10_000,
  },
} as Provider.Model

function output(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })(),
  } as unknown as Awaited<ReturnType<typeof LLM.stream>>
}

async function setup() {
  const session = await Session.create({})
  const user = (await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: model.providerID, modelID: model.id },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)) as MessageV2.User
  const assistant = (await Session.updateMessage({
    id: MessageID.ascending(),
    parentID: user.id,
    role: "assistant",
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: model.id,
    providerID: model.providerID,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    time: { created: Date.now() },
    sessionID: session.id,
  })) as MessageV2.Assistant
  return {
    session,
    processor: SessionProcessor.create({
      assistantMessage: assistant,
      sessionID: session.id,
      model,
      abort: new AbortController().signal,
    }),
    input: {
      user,
      sessionID: session.id,
      model,
      agent: {
        name: "test",
        mode: "primary",
        permission: [],
        options: {},
      },
      system: [],
      abort: new AbortController().signal,
      messages: [],
      tools: {},
    } as unknown as LLM.StreamInput,
  }
}

describe("MOD-15 failure modes", () => {
  test("retryable provider errors use the real processor retry path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_failure_retry"),
          fn: async () => {
            const ctx = await setup()
            const seen: SessionStatus.Info[] = []
            const now = spyOn(Date, "now").mockImplementation(() => 1000)
            const sleep = spyOn(SessionRetry, "sleep").mockImplementation(async () => {
              seen.push(SessionStatus.get(ctx.session.id))
            })
            let calls = 0
            const stream = spyOn(LLM, "stream").mockImplementation(async () => {
              calls++
              if (calls === 1) {
                return output([
                  { type: "start" },
                  {
                    type: "error",
                    error: new APICallError({
                      message: "Overloaded",
                      url: "https://provider.test",
                      requestBodyValues: {},
                      statusCode: 503,
                      responseHeaders: { "retry-after-ms": "2500" },
                      responseBody: "Overloaded",
                      isRetryable: true,
                    }),
                  },
                ])
              }
              return output([
                { type: "start" },
                {
                  type: "finish-step",
                  finishReason: "stop",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                },
              ])
            })

            try {
              await ctx.processor.process(ctx.input)
            } finally {
              stream.mockRestore()
              sleep.mockRestore()
              now.mockRestore()
            }

            expect(seen).toEqual([
              {
                type: "retry",
                attempt: 1,
                message: "Provider is overloaded",
                next: 3500,
              },
            ])
            expect(calls).toBe(2)
          },
        }),
    })
  })

  test("nonretryable provider errors use the real processor error path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_failure_error"),
          fn: async () => {
            const ctx = await setup()
            const stream = spyOn(LLM, "stream").mockImplementation(async () =>
              output([
                { type: "start" },
                {
                  type: "error",
                  error: new APICallError({
                    message: "bad key",
                    url: "https://provider.test",
                    requestBodyValues: {},
                    statusCode: 401,
                    responseHeaders: {},
                    responseBody: '{"error":{"message":"bad key"}}',
                    isRetryable: false,
                  }),
                },
              ]),
            )

            try {
              await expect(ctx.processor.process(ctx.input)).rejects.toThrow("bad key")
            } finally {
              stream.mockRestore()
            }

            expect(SessionStatus.get(ctx.session.id)).toEqual({ type: "error", message: "bad key" })
          },
        }),
    })
  })
})
