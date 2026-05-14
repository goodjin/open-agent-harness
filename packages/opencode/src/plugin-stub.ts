// Stub for removed plugin system - provides no-op implementations
// This file replaces the removed src/plugin/ directory

import type { Hooks } from "@opencode-ai/plugin"

export namespace Plugin {
  // No-op: return output unchanged
  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    return output
  }

  // No-op: return empty list
  export async function list() {
    return [] as Hooks[]
  }

  // No-op: do nothing
  export async function init() {}
}
