import { Instance } from "@/project/instance"
import { AsyncLocalStorage } from "async_hooks"
import z from "zod"

export namespace Trace {
  export const Span = z
    .object({
      id: z.string(),
      parentID: z.string().optional(),
      name: z.string(),
      time: z.object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative().optional(),
      }),
      attrs: z.record(z.string(), z.string()).optional(),
    })
    .meta({
      ref: "TraceSpan",
    })
  export type Span = z.infer<typeof Span>

  const store = new AsyncLocalStorage<string>()
  const state = Instance.state(() => {
    const spans: Span[] = []
    return { spans }
  })

  function id() {
    return `span_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }

  export function begin(name: string, attrs?: Record<string, string>) {
    const span: Span = {
      id: id(),
      parentID: store.getStore(),
      name,
      attrs,
      time: {
        start: Date.now(),
      },
    }
    state().spans.push(span)
    return span
  }

  export function end(id: string) {
    const span = state().spans.find((item) => item.id === id)
    if (!span) return
    span.time.end = Date.now()
  }

  export async function run<T>(name: string, attrs: Record<string, string>, fn: () => Promise<T>) {
    const span = begin(name, attrs)
    return store.run(span.id, async () => {
      try {
        return await fn()
      } finally {
        end(span.id)
      }
    })
  }

  export function list() {
    return [...state().spans]
  }

  export function clear() {
    state().spans.splice(0)
  }
}
