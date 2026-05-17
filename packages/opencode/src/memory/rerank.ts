import { Memory } from "./schema"

export namespace MemoryReranker {
  export type Input = {
    query: string
    memories: Memory.Record[]
  }

  export type Rank = {
    id: string
    score: number
  }

  export type Info = {
    rank(input: Input): Promise<Rank[]>
  }

  function terms(text: string) {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((term) => term.length > 1)
  }

  export class Keyword implements Info {
    async rank(input: Input) {
      const query = new Set(terms(input.query))
      return input.memories
        .map((memory) => {
          const words = new Set([...terms(memory.text), ...memory.topics.flatMap(terms)])
          const hits = [...query].filter((term) => words.has(term)).length
          return {
            id: memory.id,
            score: query.size === 0 ? 0 : hits / query.size,
          }
        })
        .sort((a, b) => b.score - a.score)
    }
  }

  export async function select(input: Input & { reranker?: Info }) {
    const ranks = await (input.reranker ?? new Keyword()).rank(input)
    const by = new Map(ranks.map((rank) => [rank.id, rank.score]))
    return input.memories
      .map((memory) => ({
        memory,
        score: by.get(memory.id) ?? 0,
      }))
      .sort((a, b) => b.score - a.score)
  }
}
