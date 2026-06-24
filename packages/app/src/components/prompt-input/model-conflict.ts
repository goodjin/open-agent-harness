import type { ModelKey } from "@/context/local"

type Input = {
  current?: ModelKey
  next: ModelKey
  ask: (message: string) => boolean
  reset: (model: ModelKey) => void
}

const same = (a: ModelKey | undefined, b: ModelKey) => a?.providerID === b.providerID && a?.modelID === b.modelID

const name = (model: ModelKey) => `${model.providerID}/${model.modelID}`

const message = (err: unknown) => {
  if (!err || typeof err !== "object" || !("data" in err)) return
  const data = (err as { data?: { message?: string } }).data
  return data?.message
}

export const resolveModelConflict = (input: Input) => {
  if (!input.current) return
  if (same(input.current, input.next)) return { model: input.next, confirm: true }

  if (input.ask(`This session is bound to ${name(input.current)}. Switch it to ${name(input.next)}?`)) {
    return { model: input.next, confirm: true }
  }

  input.reset(input.current)
}

export const modelConflictStatus = (err: unknown) => {
  const item = err as { status?: number; response?: { status?: number }; name?: string }
  if ((item.status ?? item.response?.status) === 409) return true
  return item.name === "ConflictError" && /has bound model/.test(message(err) ?? "")
}

export const modelConflictCurrent = (err: unknown): ModelKey | undefined => {
  const match = /has bound model "([^/"]*)\/([^"]*)"/.exec(message(err) ?? "")
  if (!match?.[1] || !match[2]) return
  return { providerID: match[1], modelID: match[2] }
}

export const resolveModelUpdate = (input: Input) => {
  if (!input.current) return { model: input.next, confirm: false }
  if (same(input.current, input.next)) return { model: input.next, confirm: false }

  if (input.ask(`This session is bound to ${name(input.current)}. Switch it to ${name(input.next)}?`)) {
    return { model: input.next, confirm: true }
  }

  input.reset(input.current)
}
