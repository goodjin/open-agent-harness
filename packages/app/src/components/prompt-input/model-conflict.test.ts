import { describe, expect, test } from "bun:test"
import type { ModelKey } from "@/context/local"
import { modelConflictCurrent, modelConflictStatus, resolveModelConflict, resolveModelUpdate } from "./model-conflict"

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

describe("resolveModelUpdate", () => {
  test("asks before replacing a bound model", () => {
    const result = resolveModelUpdate({
      current: old,
      next,
      ask: () => true,
      reset: () => undefined,
    })

    expect(result).toEqual({ model: next, confirm: true })
  })

  test("does not call update when the user cancels a bound model replacement", () => {
    const resets: ModelKey[] = []
    const result = resolveModelUpdate({
      current: old,
      next,
      ask: () => false,
      reset: (model) => resets.push(model),
    })

    expect(result).toBeUndefined()
    expect(resets).toEqual([old])
  })

  test("updates without confirmation when no bound model is known", () => {
    const asks: string[] = []
    const result = resolveModelUpdate({
      next,
      ask: (message) => {
        asks.push(message)
        return true
      },
      reset: () => undefined,
    })

    expect(result).toEqual({ model: next, confirm: false })
    expect(asks).toEqual([])
  })

  test("updates without confirmation when the model already matches", () => {
    const asks: string[] = []
    const result = resolveModelUpdate({
      current: old,
      next: old,
      ask: (message) => {
        asks.push(message)
        return false
      },
      reset: () => undefined,
    })

    expect(result).toEqual({ model: old, confirm: false })
    expect(asks).toEqual([])
  })
})

describe("modelConflictStatus", () => {
  test("recognizes generated SDK conflict bodies without an HTTP status field", () => {
    const err = {
      name: "ConflictError",
      data: {
        message:
          'Session ses_1 has bound model "minimaxi-ultra/MiniMax-M3". Pass confirm=true to overwrite it with "minimax-cn-coding-plan/MiniMax-M3".',
      },
    }

    expect(modelConflictStatus(err)).toBe(true)
  })
})

describe("modelConflictCurrent", () => {
  test("extracts the currently bound model from a conflict body", () => {
    const err = {
      name: "ConflictError",
      data: {
        message:
          'Session ses_1 has bound model "minimaxi-ultra/MiniMax-M3". Pass confirm=true to overwrite it with "minimax-cn-coding-plan/MiniMax-M3".',
      },
    }

    expect(modelConflictCurrent(err)).toEqual({ providerID: "minimaxi-ultra", modelID: "MiniMax-M3" })
  })
})
