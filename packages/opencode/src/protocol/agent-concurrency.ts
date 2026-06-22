import type { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"

export type AgentConcurrencyConfig = {
  concurrency?: number
}

export namespace AgentConcurrency {
  type Item = {
    key: string
    max: number
    agent: Agent.Info
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

  export function limit(input: { agent: string; kind?: string; cfg?: AgentConcurrencyConfig }) {
    if (input.cfg?.concurrency === -1) return
    if (input.cfg?.concurrency) return input.cfg.concurrency
    if (input.agent === "epic-planner") return 2
    if (input.agent === "feature-planner") return 5
    if (input.kind === "planner") return 1
    return
  }

  function key(agent: string) {
    return `${Instance.project.id}:${Instance.directory}:${agent}`
  }

  function count(key: string) {
    return active.get(key) ?? 0
  }

  function enter(key: string) {
    active.set(key, count(key) + 1)
  }

  function leave(key: string) {
    const next = Math.max(0, count(key) - 1)
    if (next === 0) active.delete(key)
    else active.set(key, next)
  }

  function waiting(key: string) {
    return queue.filter((item) => item.key === key).length
  }

  function publish(item: Item) {
    SessionStatus.set(item.sessionID, {
      type: "rate_limited",
      providerID: item.model.providerID,
      modelID: item.model.id,
      scope: "agent",
      agent: item.agent.name,
      active: count(item.key),
      limit: item.max,
      queued: waiting(item.key),
    })
  }

  function pump(key: string) {
    for (let idx = 0; idx < queue.length; ) {
      const item = queue[idx]
      if (!item) break
      if (item.key !== key) {
        idx++
        continue
      }
      if (count(item.key) >= item.max) {
        publish(item)
        idx++
        continue
      }
      queue.splice(idx, 1)
      enter(item.key)
      item.run()
    }
  }

  export async function acquire(input: {
    agent: Agent.Info
    model: Provider.Model
    sessionID: SessionID
    abort: AbortSignal
  }): Promise<Release> {
    const max = limit({
      agent: input.agent.name,
      kind: input.agent.kind,
      cfg: { concurrency: input.agent.concurrency },
    })
    if (!max) return noop

    const id = key(input.agent.name)
    if (count(id) < max) {
      enter(id)
      return lease(id)
    }

    const item: Item = {
      key: id,
      max,
      agent: input.agent,
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
        const state = SessionStatus.get(input.sessionID)
        if (state.type === "rate_limited" && state.scope === "agent") {
          SessionStatus.set(input.sessionID, { type: "idle" })
        }
        item.fail(input.abort.reason ?? new Error("Aborted"))
      }
      queue.push(item)
      publish(item)
      input.abort.addEventListener("abort", item.abort, { once: true })
    }).finally(() => {
      input.abort.removeEventListener("abort", item.abort)
    })

    SessionStatus.set(input.sessionID, { type: "running" })
    return lease(id)
  }

  function lease(key: string): Release {
    let done = false
    return () => {
      if (done) return
      done = true
      leave(key)
      pump(key)
    }
  }
}
