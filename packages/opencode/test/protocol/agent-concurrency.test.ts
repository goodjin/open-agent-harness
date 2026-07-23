import { describe, expect, test } from "bun:test"
import { AgentConcurrency } from "../../src/protocol/agent-concurrency"
import { Instance } from "../../src/project/instance"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { SessionID } from "../../src/session/schema"

describe("AgentConcurrency", () => {
  const model = {
    id: "gpt-test",
    providerID: "openai",
  } as Provider.Model

  const agent = (input: { name: string; kind?: Agent.Info["kind"]; concurrency?: number }) =>
    ({
      name: input.name,
      kind: input.kind,
      concurrency: input.concurrency,
    }) as Agent.Info

  test("defaults milestone planner to one concurrent task", () => {
    expect(AgentConcurrency.limit({ agent: "milestone-planner", kind: "planner" })).toBe(1)
  })

  test("defaults feature planner to five concurrent tasks", () => {
    expect(AgentConcurrency.limit({ agent: "feature-planner", kind: "planner" })).toBe(5)
  })

  test("does not limit workers by default", () => {
    expect(AgentConcurrency.limit({ agent: "backend", kind: "worker" })).toBeUndefined()
    expect(AgentConcurrency.limit({ agent: "frontend", kind: "worker" })).toBeUndefined()
  })

  test("uses agent metadata override before defaults", () => {
    expect(AgentConcurrency.limit({ agent: "feature-planner", kind: "planner", cfg: { concurrency: 4 } })).toBe(4)
  })

  test("treats negative agent metadata as unlimited", () => {
    expect(AgentConcurrency.limit({ agent: "feature-planner", kind: "planner", cfg: { concurrency: -1 } })).toBeUndefined()
  })

  test("waits for same project and same agent slot before request submission", async () => {
    await Instance.provide({
      directory: await tmp(),
      fn: async () => {
        const abort = new AbortController()
        const one = await AgentConcurrency.acquire({
          agent: agent({ name: "backend", kind: "worker", concurrency: 1 }),
          model,
          sessionID: SessionID.make("ses_1"),
          abort: abort.signal,
        })
        let done = false
        const two = AgentConcurrency.acquire({
          agent: agent({ name: "backend", kind: "worker", concurrency: 1 }),
          model,
          sessionID: SessionID.make("ses_2"),
          abort: abort.signal,
        }).then((release) => {
          done = true
          return release
        })

        await Promise.resolve()
        expect(done).toBe(false)
        one()

        const release = await two
        expect(done).toBe(true)
        release()
      },
    })
  })

  test("does not share slots across different agents", async () => {
    await Instance.provide({
      directory: await tmp(),
      fn: async () => {
        const abort = new AbortController()
        const one = await AgentConcurrency.acquire({
          agent: agent({ name: "backend", kind: "worker", concurrency: 1 }),
          model,
          sessionID: SessionID.make("ses_3"),
          abort: abort.signal,
        })
        const two = await AgentConcurrency.acquire({
          agent: agent({ name: "frontend", kind: "worker", concurrency: 1 }),
          model,
          sessionID: SessionID.make("ses_4"),
          abort: abort.signal,
        })

        two()
        one()
      },
    })
  })
})

async function tmp() {
  return await Bun.$`mktemp -d`.text().then((out) => out.trim())
}
