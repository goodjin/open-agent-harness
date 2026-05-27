const cmds = new Set([
  "awk",
  "bun",
  "cat",
  "cd",
  "chmod",
  "cp",
  "curl",
  "date",
  "docker",
  "echo",
  "find",
  "git",
  "grep",
  "head",
  "kill",
  "kubectl",
  "ls",
  "make",
  "mkdir",
  "mv",
  "node",
  "npm",
  "pnpm",
  "ps",
  "pwd",
  "python",
  "python3",
  "rg",
  "rm",
  "sed",
  "tail",
  "touch",
  "tree",
  "unzip",
  "which",
  "yarn",
])

const ops = /(^|\s)(&&|\|\||\||>|>>|<|2>|2>&1)(\s|$)/
const assign = /^[A-Za-z_][A-Za-z0-9_]*=.*\s+\S+/

export function isShellCommand(text: string) {
  const value = text.trim()
  if (!value) return false
  if (ops.test(value) || assign.test(value)) return true
  const head = value.match(/^([A-Za-z0-9_.-]+)/)?.[1]
  if (!head) return false
  return cmds.has(head)
}
