type Mode = "all" | "primary" | "subagent"

type Item = {
  mode?: Mode
  hidden?: boolean
  entry?: {
    primary?: boolean
    delegable?: boolean
    mentionable?: boolean
    hidden?: boolean
  }
}

export namespace AgentEntry {
  export function hidden(item: Item) {
    return item.entry?.hidden === true || item.hidden === true
  }

  export function primary(item: Item) {
    return (item.entry?.primary ?? item.mode !== "subagent") && !hidden(item)
  }

  export function mentionable(item: Item) {
    return (item.entry?.mentionable ?? item.mode !== "primary") && !hidden(item)
  }

  export function delegable(item: Item) {
    return (item.entry?.delegable ?? item.mode !== "primary") && !hidden(item)
  }

  export function subtask(item: Item) {
    if (item.entry) return item.entry.delegable === true && item.entry.primary !== true && !hidden(item)
    return item.mode === "subagent" && !hidden(item)
  }
}
