import { SessionStatus } from "./status"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "./schema"
import { Instance } from "@/project/instance"

export namespace LLMConcurrency {
  type Limit = {
    key: string
    max: number
    scope: "provider" | "model"
    kind: "concurrency" | "rpm"
  }

  type Block = Limit & {
    active: number
    delay?: number
  }

  type Item = {
    limits: Limit[]
    sessionID: SessionID
    model: Provider.Model
    run: () => void
    fail: (err: unknown) => void
    abort: () => void
    get: () => SessionStatus.Info
    set: (status: SessionStatus.Info) => void
  }

  export type Release = () => void

  const noop: Release = () => {}

  const active = new Map<string, number>()
  const starts = new Map<string, number[]>()
  const queue: Item[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  function span() {
    const ms = Number(process.env.OPENCODE_LLM_RPM_WINDOW_MS)
    if (Number.isInteger(ms) && ms > 0) return ms
    return 60_000
  }

  function count(key: string) {
    return active.get(key) ?? 0
  }

  function trim(key: string, now = Date.now()) {
    const next = (starts.get(key) ?? []).filter((time) => time > now - span())
    if (next.length === 0) starts.delete(key)
    else starts.set(key, next)
    return next
  }

  function used(limit: Limit) {
    if (limit.kind === "rpm") return trim(limit.key).length
    return count(limit.key)
  }

  function delay(limit: Limit) {
    if (limit.kind !== "rpm") return undefined
    const hits = trim(limit.key)
    if (hits.length < limit.max) return undefined
    return Math.max(1, hits[0] + span() - Date.now())
  }

  function limit(model: Provider.Model, provider: Provider.Info) {
    return [
      {
        key: `provider:${provider.id}`,
        max: provider.concurrency,
        scope: "provider" as const,
        kind: "concurrency" as const,
      },
      {
        key: `model:${model.providerID}/${model.id}`,
        max: model.concurrency,
        scope: "model" as const,
        kind: "concurrency" as const,
      },
      {
        key: `provider:${provider.id}:rpm`,
        max: provider.rpm,
        scope: "provider" as const,
        kind: "rpm" as const,
      },
      {
        key: `model:${model.providerID}/${model.id}:rpm`,
        max: model.rpm,
        scope: "model" as const,
        kind: "rpm" as const,
      },
    ].filter((item): item is Limit => typeof item.max === "number" && Number.isInteger(item.max) && item.max > 0)
  }

  function blocked(limits: Limit[]): Block | undefined {
    for (const item of limits) {
      const active = used(item)
      if (active >= item.max) return { ...item, active, delay: delay(item) }
    }
  }

  function enter(limits: Limit[]) {
    const now = Date.now()
    for (const item of limits) {
      if (item.kind === "rpm") {
        starts.set(item.key, [...trim(item.key, now), now])
        continue
      }
      active.set(item.key, count(item.key) + 1)
    }
  }

  function leave(limits: Limit[]) {
    for (const item of limits) {
      if (item.kind === "rpm") continue
      const next = Math.max(0, count(item.key) - 1)
      if (next === 0) active.delete(item.key)
      else active.set(item.key, next)
    }
  }

  function waiting(key: string) {
    return queue.filter((item) => item.limits.some((limit) => limit.key === key)).length
  }

  function publish(item: Item, limit: Block) {
    item.set({
      type: "rate_limited",
      providerID: item.model.providerID,
      modelID: item.model.id,
      scope: limit.scope,
      kind: limit.kind,
      active: limit.active,
      limit: limit.max,
      queued: waiting(limit.key),
      reset: limit.kind === "rpm" && limit.delay ? Date.now() + limit.delay : undefined,
    })
  }

  function schedule() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const delays = queue
      .map((item) => blocked(item.limits))
      .filter((item): item is Block => item?.kind === "rpm" && typeof item.delay === "number")
      .map((item) => item.delay!)
    if (delays.length === 0) return
    timer = setTimeout(() => {
      timer = undefined
      pump()
    }, Math.min(...delays))
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
    schedule()
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

    const get = Instance.bind(() => SessionStatus.get(input.sessionID))
    const set = Instance.bind((status: SessionStatus.Info) => SessionStatus.set(input.sessionID, status))
    const item: Item = {
      limits,
      sessionID: input.sessionID,
      model: input.model,
      run: () => {},
      fail: () => {},
      abort: () => {},
      get,
      set,
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
        const current = item.get()
        if (current.type === "rate_limited") {
          item.set({ type: "idle" })
        }
        item.fail(input.abort.reason ?? new Error("Aborted"))
      }
      queue.push(item)
      publish(item, current)
      schedule()
      input.abort.addEventListener("abort", item.abort, { once: true })
    }).finally(() => {
      input.abort.removeEventListener("abort", item.abort)
    })

    item.set({ type: "running" })
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
