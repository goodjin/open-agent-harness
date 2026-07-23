type Generation = {
  pending: Set<Promise<void>>
}

export namespace Admission {
  const gates = new Map<string, Generation>()

  export function signal(key: string) {
    const gate = Promise.withResolvers<void>()
    const own = gates.get(key) ?? { pending: new Set<Promise<void>>() }
    own.pending.add(gate.promise)
    gates.set(key, own)
    let done = false
    return () => {
      if (done) return
      done = true
      own.pending.delete(gate.promise)
      gate.resolve()
      if (gates.get(key) === own && own.pending.size === 0) gates.delete(key)
    }
  }

  export async function wait(key: string, timeout = 5_000) {
    const end = Date.now() + timeout
    await Promise.resolve()
    while (true) {
      const own = gates.get(key)
      const pending = own ? [...own.pending] : []
      if (pending.length === 0) {
        await Promise.resolve()
        if (gates.get(key) === own && (!own || own.pending.size === 0)) return true
        continue
      }
      const left = end - Date.now()
      if (left <= 0) return false
      if (!(await bounded(Promise.allSettled(pending), left))) return false
    }
  }

  function bounded(input: Promise<unknown>, timeout: number) {
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (value: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), timeout)
      timer.unref?.()
      input.then(
        () => finish(true),
        () => finish(true),
      )
    })
  }
}
