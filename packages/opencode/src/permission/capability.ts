import z from "zod"

export namespace Capability {
  export const Dimension = z.enum(["tool", "file", "command", "network", "agent", "quota"])
  export type Dimension = z.infer<typeof Dimension>

  export const Item = z
    .object({
      dimension: Dimension,
      permission: z.string().min(1),
      pattern: z.string().min(1).default("*"),
    })
    .strict()
  export type Item = z.infer<typeof Item>

  const EDIT = new Set(["edit", "write", "patch", "multiedit"])
  const FILE = new Set(["read", "edit", "write", "patch", "multiedit", "glob", "grep", "list", "external_directory"])
  const COMMAND = new Set(["bash"])
  const NETWORK = new Set(["webfetch", "websearch", "codesearch"])
  const AGENT = new Set(["task"])
  const QUOTA = new Set(["doom_loop"])

  export function normalize(permission: string) {
    if (EDIT.has(permission)) return "edit"
    return permission
  }

  export function dimension(permission: string): Dimension {
    const name = normalize(permission)
    if (COMMAND.has(name)) return "command"
    if (NETWORK.has(name)) return "network"
    if (AGENT.has(name)) return "agent"
    if (QUOTA.has(name)) return "quota"
    if (FILE.has(name)) return "file"
    return "tool"
  }

  export function make(permission: string, pattern = "*"): Item {
    const name = normalize(permission)
    return {
      dimension: dimension(name),
      permission: name,
      pattern,
    }
  }
}
