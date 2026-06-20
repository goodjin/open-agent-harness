import { describe, expect, test } from "bun:test"
import type { ModelKey } from "@/context/local"
import { resolveModelConflict } from "./model-conflict"

const old: ModelKey = { providerID: "minimax-cn-coding-plan", modelID: "MiniMax-M3" }
const next: ModelKey = { providerID: "minimaxi-ultra", modelID: "MiniMax-M3" }

describe("resolveModelConflict", () => {
  test("returns a confirmed retry when the user approves the model switch", () => {
    const result = resolveModelConflict({
      current: old,
      next,
      ask: () => true,
      reset: () => undefined,
    })

    expect(result).toEqual({ model: next, confirm: true })
  })

  test("restores the bound model when the user cancels", () => {
    const resets: ModelKey[] = []
    const result = resolveModelConflict({
      current: old,
      next,
      ask: () => false,
      reset: (model) => resets.push(model),
    })

    expect(result).toBeUndefined()
    expect(resets).toEqual([old])
  })

  test("does not ask when no bound model is available", () => {
    const asks: string[] = []
    const result = resolveModelConflict({
      next,
      ask: (message) => {
        asks.push(message)
        return true
      },
      reset: () => undefined,
    })

    expect(result).toBeUndefined()
    expect(asks).toEqual([])
  })

  test("allows retry when the requested model already matches the bound model", () => {
    const asks: string[] = []
    const result = resolveModelConflict({
      current: old,
      next: old,
      ask: (message) => {
        asks.push(message)
        return false
      },
      reset: () => undefined,
    })

    expect(result).toEqual({ model: old, confirm: true })
    expect(asks).toEqual([])
  })
})
