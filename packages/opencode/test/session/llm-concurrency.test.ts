import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { LLMConcurrency } from "../../src/session/llm-concurrency"
import { SessionStatus } from "../../src/session/status"
import type { Provider } from "../../src/provider/provider"
import { SessionID } from "../../src/session/schema"

const provider = {
  id: "lease-provider",
  concurrency: 1,
} as Provider.Info

const model = {
  id: "lease-model",
  providerID: "lease-provider",
  concurrency: 1,
} as Provider.Model

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("LLMConcurrency", () => {
  test("releases a slot when the lease timeout expires", async () => {
    await Instance.provide({
      directory: __dirname,
      fn: async () => {
        const one = await LLMConcurrency.acquire({
          model,
          provider,
          sessionID: SessionID.make("ses_lease_one"),
          abort: new AbortController().signal,
          timeout: 10,
        })
        let ran = false
        const two = LLMConcurrency.acquire({
          model,
          provider,
          sessionID: SessionID.make("ses_lease_two"),
          abort: new AbortController().signal,
          timeout: false,
        }).then((release) => {
          ran = true
          release()
        })

        expect(ran).toBe(false)
        await wait(25)
        expect(ran).toBe(true)
        one()
        await two
      },
    })
  })

  test("clears the lease timeout on normal release", async () => {
    await Instance.provide({
      directory: __dirname,
      fn: async () => {
        const id = SessionID.make("ses_lease_release")
        const release = await LLMConcurrency.acquire({
          model,
          provider,
          sessionID: id,
          abort: new AbortController().signal,
          timeout: 10,
        })

        release()
        await wait(25)

        expect(SessionStatus.get(id).type).toBe("idle")
      },
    })
  })

  test("extends the lease when progress is reported", async () => {
    await Instance.provide({
      directory: __dirname,
      fn: async () => {
        const id = SessionID.make("ses_lease_touch")
        const release = await LLMConcurrency.acquire({
          model,
          provider,
          sessionID: id,
          abort: new AbortController().signal,
          timeout: 20,
        })

        await wait(10)
        release.touch()
        await wait(15)
        expect(SessionStatus.get(id).type).toBe("idle")
        release()
      },
    })
  })
})
