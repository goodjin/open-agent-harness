import { SessionStatus } from "./status"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "./schema"

export namespace LLMConcurrency {
  type Limit = {
    key: string
    max: number
    scope: "provider" | "model"
  }

  type Item = {
    limits: Limit[]
    sessionID: SessionID
    model: Provider.Model
    run: () => void
    fail: (err: unknown) => void
    abort: () => void
  }

  export type Release = () => void

  const noop: Release = () => {}

  const active = new Map<string, number>()
  const queue: Item[] = []

  function count(key: string) {
    return active.get(key) ?? 0
  }

  function limit(model: Provider.Model, provider: Provider.Info) {
    return [
      {
        key: `provider:${provider.id}`,
        max: provider.concurrency,
        scope: "provider" as const,
      },
      {
        key: `model:${model.providerID}/${model.id}`,
        max: model.concurrency,
        scope: "model" as const,
      },
    ].filter((item): item is Limit => typeof item.max === "number" && Number.isInteger(item.max) && item.max > 0)
  }

  function blocked(limits: Limit[]) {
    return limits.find((item) => count(item.key) >= item.max)
  }

  function enter(limits: Limit[]) {
    for (const item of limits) {
      active.set(item.key, count(item.key) + 1)
    }
  }

  function leave(limits: Limit[]) {
    for (const item of limits) {
      const next = Math.max(0, count(item.key) - 1)
      if (next === 0) active.delete(item.key)
      else active.set(item.key, next)
    }
  }

  function waiting(key: string) {
    return queue.filter((item) => item.limits.some((limit) => limit.key === key)).length
  }

  function publish(item: Item, limit: Limit) {
    SessionStatus.set(item.sessionID, {
      type: "rate_limited",
      providerID: item.model.providerID,
      modelID: item.model.id,
      scope: limit.scope,
      active: count(limit.key),
      limit: limit.max,
      queued: waiting(limit.key),
    })
  }

  function pump() {
    for (let idx = 0; idx < queue.length; ) {
      const item = queue[idx]
      if (!item) break
      const limit = blocked(item.limits)
      if (limit) {
        publish(item, limit)
        idx++
        continue
      }
      queue.splice(idx, 1)
      enter(item.limits)
      item.run()
    }
  }

  export async function acquire(input: {
    model: Provider.Model
    provider: Provider.Info
    sessionID: SessionID
    abort: AbortSignal
  }): Promise<Release> {
    const limits = limit(input.model, input.provider)
    if (limits.length === 0) return noop

    const current = blocked(limits)
    if (!current) {
      enter(limits)
      return lease(limits)
    }

    const item: Item = {
      limits,
      sessionID: input.sessionID,
      model: input.model,
      run: () => {},
      fail: () => {},
      abort: () => {},
    }
    await new Promise<void>((resolve, reject) => {
      item.run = resolve
      item.fail = reject
      item.abort = () => {
        const idx = queue.indexOf(item)
        if (idx !== -1) queue.splice(idx, 1)
        // The slot was never acquired, but `publish` already set the
        // session status to `rate_limited` when the item was enqueued.
        // Reset it so aborted-while-queued sessions don't show a stale
        // "waiting for concurrency slot" notification forever. Only
        // touch the status if it is still `rate_limited` to avoid
        // clobbering a transition that happened in the meantime.
        const current = SessionStatus.get(input.sessionID)
        if (current.type === "rate_limited") {
          SessionStatus.set(input.sessionID, { type: "idle" })
        }
        item.fail(input.abort.reason ?? new Error("Aborted"))
      }
      queue.push(item)
      publish(item, current)
      input.abort.addEventListener("abort", item.abort, { once: true })
    }).finally(() => {
      input.abort.removeEventListener("abort", item.abort)
    })

    SessionStatus.set(input.sessionID, { type: "running" })
    return lease(limits)
  }

  function lease(limits: Limit[]): Release {
    let done = false
    return () => {
      if (done) return
      done = true
      release(limits)
    }
  }

  function release(limits: Limit[]) {
    leave(limits)
    pump()
  }
}
