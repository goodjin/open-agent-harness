import { Log } from "@/util/log"

export namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

  export type Accessor<S> = (() => S) & {
    reset: (key?: string) => Promise<void>
  }

  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    const read = (() => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose,
      })
      return state
    }) as Accessor<S>

    read.reset = async (key = root()) => {
      await remove(key, init)
    }

    return read
  }

  async function cleanup(key: string, init: any, entry: Entry) {
    if (!entry.dispose) return
    const label = typeof init === "function" ? init.name : String(init)
    await Promise.resolve(entry.state)
      .then((state) => entry.dispose!(state))
      .catch((error) => {
        log.error("Error while disposing state:", { error, key, init: label })
      })
  }

  export async function remove(key: string, init: any) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    const entry = entries.get(init)
    if (!entry) return

    entries.delete(init)
    if (entries.size === 0) recordsByKey.delete(key)
    await cleanup(key, init, entry)
  }

  export async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false

    setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000).unref()

    const tasks: Promise<void>[] = []
    for (const [init, entry] of entries) {
      tasks.push(cleanup(key, init, entry))
    }
    await Promise.all(tasks)

    entries.clear()
    recordsByKey.delete(key)

    disposalFinished = true
    log.info("state disposal completed", { key })
  }
}
