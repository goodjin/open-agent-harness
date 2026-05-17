import { Memory } from "./schema"

export namespace MemoryAdapter {
  export type Entry = {
    id: string
    text: string
    vector?: number[]
  }

  export type Hit = {
    id: string
    score: number
  }

  export type Search = {
    query: string
    limit?: number
    vector?: number[]
  }

  export type Info = {
    upsert(input: Entry[]): Promise<void>
    remove(input: string[]): Promise<void>
    search(input: Search): Promise<Hit[]>
  }

  export type Qdrant = Info & {
    collection: string
  }

  function terms(text: string) {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((term) => term.length > 1)
  }

  function score(query: string, text: string) {
    const q = new Set(terms(query))
    const t = new Set(terms(text))
    if (q.size === 0 || t.size === 0) return 0
    const hits = [...q].filter((term) => t.has(term)).length
    return hits / Math.sqrt(q.size * t.size)
  }

  function cosine(a: number[], b: number[]) {
    const len = Math.min(a.length, b.length)
    const dot = Array.from({ length: len }).reduce<number>((sum, _, idx) => sum + a[idx] * b[idx], 0)
    const left = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))
    const right = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0))
    if (left === 0 || right === 0) return 0
    return dot / (left * right)
  }

  export class Local implements Info {
    private entries = new Map<string, Entry>()

    async upsert(input: Entry[]) {
      input.forEach((entry) => this.entries.set(entry.id, entry))
    }

    async remove(input: string[]) {
      input.forEach((id) => this.entries.delete(id))
    }

    async search(input: Search) {
      return [...this.entries.values()]
        .map((entry) => ({
          id: entry.id,
          score:
            input.vector && entry.vector
              ? Math.max(cosine(input.vector, entry.vector), score(input.query, entry.text))
              : score(input.query, entry.text),
        }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10)
    }
  }

  export function entries(input: Memory.Record[]): Entry[] {
    return input.map((record) => ({
      id: record.id,
      text: record.text,
      vector: record.vector,
    }))
  }
}
