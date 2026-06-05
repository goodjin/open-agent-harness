import { Instance } from "../project/instance"
import { Log } from "../util/log"

export namespace Scheduler {
  const log = Log.create({ service: "scheduler" })

  let completed = 0
  let failed = 0
  let active = 0
  let lastError: string | undefined

  export type Task = {
    id: string
    interval: number
    run: () => Promise<void>
    scope?: "instance" | "global"
  }

  type Timer = ReturnType<typeof setInterval>
  type Entry = {
    tasks: Map<string, Task>
    timers: Map<string, Timer>
  }

  const create = (): Entry => {
    const tasks = new Map<string, Task>()
    const timers = new Map<string, Timer>()
    return { tasks, timers }
  }

  const shared = create()

  const state = Instance.state(
    () => create(),
    async (entry) => {
      for (const timer of entry.timers.values()) {
        clearInterval(timer)
      }
      entry.tasks.clear()
      entry.timers.clear()
    },
  )

  export function register(task: Task) {
    const scope = task.scope ?? "instance"
    const entry = scope === "global" ? shared : state()
    const current = entry.timers.get(task.id)
    if (current && scope === "global") return
    if (current) clearInterval(current)

    entry.tasks.set(task.id, task)
    void run(task)
    const timer = setInterval(() => {
      void run(task)
    }, task.interval)
    timer.unref()
    entry.timers.set(task.id, timer)
  }

  async function run(task: Task) {
    active += 1
    log.info("run", { id: task.id })
    try {
      await task.run()
      completed += 1
    } catch (error) {
      failed += 1
      lastError = String(error)
      log.error("run failed", { id: task.id, error })
    } finally {
      active -= 1
    }
  }

  export function metrics() {
    const stateRef = Instance.directory
      ? shared.tasks.size + state().tasks.size
      : shared.tasks.size
    return {
      registered: stateRef,
      active,
      completed,
      failed,
      last_error: lastError,
    }
  }

  export function reset() {
    completed = 0
    failed = 0
    active = 0
    lastError = undefined
  }
}
