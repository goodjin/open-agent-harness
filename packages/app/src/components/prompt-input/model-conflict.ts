import type { ModelKey } from "@/context/local"

type Input = {
  current?: ModelKey
  next: ModelKey
  ask: (message: string) => boolean
  reset: (model: ModelKey) => void
}

const same = (a: ModelKey | undefined, b: ModelKey) => a?.providerID === b.providerID && a?.modelID === b.modelID

const name = (model: ModelKey) => `${model.providerID}/${model.modelID}`

export const resolveModelConflict = (input: Input) => {
  if (!input.current) return
  if (same(input.current, input.next)) return { model: input.next, confirm: true }

  if (input.ask(`This session is bound to ${name(input.current)}. Switch it to ${name(input.next)}?`)) {
    return { model: input.next, confirm: true }
  }

  input.reset(input.current)
}
