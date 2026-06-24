import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
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
  test("releases a slot when the active lease is released", async () => {
    await Instance.provide({
      directory: __dirname,
      fn: async () => {
        const one = await LLMConcurrency.acquire({
          model,
          provider,
          sessionID: SessionID.make("ses_lease_one"),
          abort: new AbortController().signal,
        })
        let ran = false
        const two = LLMConcurrency.acquire({
          model,
          provider,
          sessionID: SessionID.make("ses_lease_two"),
          abort: new AbortController().signal,
        }).then((release) => {
          ran = true
          release()
        })

        expect(ran).toBe(false)
        // Lease-level inactivity is no longer treated as timeout; the slot only
        // frees up when the holder explicitly releases (i.e. HTTP stream ends
        // or the request is aborted at the fetch layer).
        one()
        await two
        expect(ran).toBe(true)
      },
    })
  })

  test("does not release a slot just because no progress was reported", async () => {
    await Instance.provide({
      directory: __dirname,
      fn: async () => {
        const id = SessionID.make("ses_lease_idle")
        SessionStatus.set(id, { type: "running" })
        const release = await LLMConcurrency.acquire({
          model,
          provider,
          sessionID: id,
          abort: new AbortController().signal,
        })

        // Inactivity must not release the slot or flip the session to
        // `timeout`. The HTTP fetch layer owns the only real timeout (it
        // aborts the request and throws TimeoutError, which processor.ts
        // maps to the `timeout` session status).
        await wait(40)
        // Lease is still owned by the holder — the second request blocks.
        let queued = false
        const second = LLMConcurrency.acquire({
          model,
          provider,
          sessionID: SessionID.make("ses_lease_idle_queued"),
          abort: new AbortController().signal,
        }).then((r) => {
          queued = true
          r()
        })
        await wait(10)
        expect(queued).toBe(false)
        release()
        await second
        expect(queued).toBe(true)
      },
    })
  })

  test("resets a queued session to idle when its acquire is aborted", async () => {
    const wide = {
      id: "lease-provider-wide",
      concurrency: 5,
    } as Provider.Info
    const wideModel = {
      id: "lease-model-wide",
      providerID: "lease-provider-wide",
      concurrency: 5,
    } as Provider.Model
    await Instance.provide({
      directory: __dirname,
      fn: async () => {
        const id = SessionID.make("ses_lease_abort")
        SessionStatus.set(id, { type: "running" })

        // Fill all 5 slots, then queue one.
        const holders: Array<() => void> = []
        for (let i = 0; i < 5; i++) {
          holders.push(
            await LLMConcurrency.acquire({
              model: wideModel,
              provider: wide,
              sessionID: SessionID.make("ses_lease_abort_a_" + i),
              abort: new AbortController().signal,
            }),
          )
        }

        const ctrl = new AbortController()
        const queued = LLMConcurrency.acquire({
          model: wideModel,
          provider: wide,
          sessionID: id,
          abort: ctrl.signal,
        })

        await wait(10)
        // Status is set to `rate_limited` by `publish` while waiting.
        expect(SessionStatus.get(id).type).toBe("rate_limited")

        // Abort the queued acquire. The slot was never taken, but the
        // session status must not stay frozen at `rate_limited` forever
        // — that was the source of the persistent "waiting for concurrency
        // slot" notification in the sidebar.
        ctrl.abort(new Error("user canceled"))
        await expect(queued).rejects.toThrow("user canceled")
        expect(SessionStatus.get(id).type).toBe("idle")

        for (const r of holders) r()
      },
    })
  })

  test("queues by rpm and resumes when the window opens", async () => {
    const prior = process.env.OPENCODE_LLM_RPM_WINDOW_MS
    process.env.OPENCODE_LLM_RPM_WINDOW_MS = "50"
    const rpmProvider = {
      id: "lease-provider-rpm",
      concurrency: 5,
      rpm: 1,
    } as Provider.Info
    const rpmModel = {
      id: "lease-model-rpm",
      providerID: "lease-provider-rpm",
      concurrency: 5,
    } as Provider.Model

    try {
      await Instance.provide({
        directory: __dirname,
        fn: async () => {
          const one = await LLMConcurrency.acquire({
            model: rpmModel,
            provider: rpmProvider,
            sessionID: SessionID.make("ses_lease_rpm_one"),
            abort: new AbortController().signal,
          })
          one()

          const id = SessionID.make("ses_lease_rpm_two")
          let ran = false
          const two = LLMConcurrency.acquire({
            model: rpmModel,
            provider: rpmProvider,
            sessionID: id,
            abort: new AbortController().signal,
          }).then((release) => {
            ran = true
            release()
          })

          await wait(10)
          const status = SessionStatus.get(id)
          expect(ran).toBe(false)
          expect(status.type).toBe("rate_limited")
          if (status.type === "rate_limited") {
            expect(status.kind).toBe("rpm")
            expect(status.scope).toBe("provider")
            expect(status.active).toBe(1)
            expect(status.limit).toBe(1)
            expect(typeof status.reset).toBe("number")
          }

          await two
          expect(ran).toBe(true)
        },
      })
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LLM_RPM_WINDOW_MS
      else process.env.OPENCODE_LLM_RPM_WINDOW_MS = prior
    }
  })

  test("keeps queued session status bound to the originating instance", async () => {
    await using one = await tmpdir()
    await using two = await tmpdir()

    const pid = "bind-blocked"
    const other = "bind-other"
    const full = {
      id: pid,
      concurrency: 1,
    } as Provider.Info
    const fullModel = {
      id: "MiniMax-M3",
      providerID: pid,
    } as Provider.Model
    const spareProvider = {
      id: other,
      concurrency: 1,
    } as Provider.Info
    const spareModel = {
      id: "MiniMax-M3",
      providerID: other,
    } as Provider.Model
    const queued = SessionID.make("ses_queued_instance_binding")
    const ctl = new AbortController()
    let first: LLMConcurrency.Release | undefined
    let second: LLMConcurrency.Release | undefined
    let third: LLMConcurrency.Release | undefined
    let task: Promise<LLMConcurrency.Release> | undefined

    try {
      await Instance.provide({
        directory: one.path,
        fn: async () => {
          first = await LLMConcurrency.acquire({
            model: fullModel,
            provider: full,
            sessionID: SessionID.make("ses_held_instance_binding"),
            abort: new AbortController().signal,
          })
          task = LLMConcurrency.acquire({
            model: fullModel,
            provider: full,
            sessionID: queued,
            abort: ctl.signal,
          })
          expect(SessionStatus.get(queued).type).toBe("rate_limited")
        },
      })

      await Instance.provide({
        directory: two.path,
        fn: async () => {
          expect(SessionStatus.get(queued).type).toBe("idle")
          third = await LLMConcurrency.acquire({
            model: spareModel,
            provider: spareProvider,
            sessionID: SessionID.make("ses_spare_instance_binding"),
            abort: new AbortController().signal,
          })
          third()
          expect(SessionStatus.get(queued).type).toBe("idle")
        },
      })

      await Instance.provide({
        directory: one.path,
        fn: async () => {
          expect(SessionStatus.get(queued).type).toBe("rate_limited")
        },
      })

      await Instance.provide({
        directory: two.path,
        fn: async () => {
          first?.()
        },
      })

      second = await Promise.race([
        task!,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for queue")), 1_000)),
      ])

      await Instance.provide({
        directory: one.path,
        fn: async () => {
          expect(SessionStatus.get(queued).type).toBe("running")
        },
      })
      await Instance.provide({
        directory: two.path,
        fn: async () => {
          expect(SessionStatus.get(queued).type).toBe("idle")
        },
      })
    } finally {
      second?.()
      first?.()
      third?.()
      ctl.abort()
      await Instance.disposeAll()
    }
  })
})
