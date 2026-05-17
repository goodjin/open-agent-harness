export namespace MemoryFilter {
  const deny = [
    /\.env(?:\b|$)/i,
    /\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]/i,
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
    /\bsk-[A-Za-z0-9_-]{8,}/i,
    /BEGIN [A-Z ]*PRIVATE KEY/,
    /^(?:\$|>)\s+\w+/m,
    /\b(?:npm ERR!|Traceback \(most recent call last\)|Error: .*\n\s+at )/,
  ]

  export function keep(input: string) {
    const text = input.trim()
    if (!text) return false
    if (deny.some((item) => item.test(text))) return false
    const lines = text.split(/\r?\n/)
    const logs = lines.filter((line) =>
      /^\s*(?:\[[^\]]+\]|(?:DEBUG|INFO|WARN|ERROR|TRACE)\b|[0-9-]{10}T[0-9:.]+Z)/i.test(line),
    )
    return logs.length < Math.max(3, lines.length / 2)
  }
}
