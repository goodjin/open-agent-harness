import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Memory } from "./schema"
import { MemoryAdapter } from "./adapter"
import { MemoryChunk } from "./chunk"
import { MemoryExtract } from "./extract"
import { MemoryReranker } from "./rerank"
import { Audit } from "@/observability/audit"

export namespace MemoryStore {
  const key = ["memory", "records"]

  function empty(err: unknown) {
    if (Storage.NotFoundError.isInstance(err)) return [] as Memory.Record[]
    throw err
  }

  export async function all() {
    return Storage.read<Memory.Record[]>(key).catch(empty)
  }

  async function write(input: Memory.Record[]) {
    await Storage.write(key, input)
  }

  function privacy(info: Session.Info, given?: Memory.Privacy) {
    if (given) return given
    return info.parentID ? "session" : "project"
  }

  function visible(input: { session?: Session.Info; memory: Memory.Record }) {
    if (input.memory.projectID !== Instance.project.id) return false
    if (input.memory.directory && input.memory.directory !== Instance.directory) return false
    if (!input.session) return input.memory.privacy === "project" && !input.memory.parentID
    if (input.memory.sessionID === input.session.id) return true
    if (input.memory.privacy === "session") return false
    if (!input.session.parentID) return true
    return !input.memory.parentID || input.memory.sessionID === input.session.parentID
  }

  function topics(input: { memory: Memory.Record; topics?: string[] }) {
    if (!input.topics?.length) return true
    const wanted = new Set(input.topics.map((topic) => topic.toLowerCase()))
    return input.memory.topics.some((topic) => wanted.has(topic.toLowerCase()))
  }

  function terms(text: string) {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((term) => term.length > 1)
  }

  function score(input: { query: string; memory: Memory.Record }) {
    const query = new Set(terms(input.query))
    const text = new Set(terms([input.memory.text, ...input.memory.topics].join(" ")))
    if (query.size === 0 || text.size === 0) return 0
    return [...query].filter((term) => text.has(term)).length
  }

  function pick(input: { query: string; records: Memory.Record[]; limit?: number }) {
    const limit = (input.limit ?? 10) * 8
    const ranked = input.records
      .map((memory) => ({ memory, score: score({ query: input.query, memory }) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.memory)
    if (ranked.length) return ranked.slice(0, limit)
    return input.records.slice(0, limit)
  }

  export async function put(input: Memory.Record[]) {
    const prev = await all()
    const ids = new Set(input.map((item) => item.id))
    const next = [...prev.filter((item) => !ids.has(item.id)), ...input]
    await write(next)
    return input
  }

  export async function replace(input: { sessionID: Session.Info["id"]; records: Memory.Record[] }) {
    const prev = await all()
    const next = [...prev.filter((item) => item.sessionID !== input.sessionID), ...input.records]
    await write(next)
    return input.records
  }

  export async function bySession(sessionID: Session.Info["id"]) {
    return (await all()).filter((memory) => memory.sessionID === sessionID)
  }

  export async function capture(input: { sessionID: Session.Info["id"]; privacy?: Memory.Privacy }) {
    const info = await Session.get(input.sessionID)
    const msgs = await Session.messages({ sessionID: input.sessionID })
    const now = Date.now()
    const picked = MemoryExtract.from(msgs)
    const base = {
      privacy: privacy(info, input.privacy),
      projectID: info.projectID,
      workspaceID: info.workspaceID,
      directory: info.directory,
      sessionID: info.id,
      parentID: info.parentID,
      topics: picked.topics,
      time: {
        created: now,
        updated: now,
      },
    }
    const summary: Memory.Record = {
      ...base,
      id: Memory.ID.ascending(),
      kind: "session",
      text: picked.summary,
      source: {
        sessionID: info.id,
      },
    }
    const chunks: Memory.Record[] = MemoryChunk.select(msgs).map((chunk) => ({
      ...base,
      id: chunk.id,
      kind: "chunk",
      text: chunk.text,
      source: chunk.source,
    }))
    const records = await replace({ sessionID: info.id, records: [summary, ...chunks] })
    void Audit.emit({
      sessionID: info.id,
      workspaceID: info.workspaceID,
      event: {
        type: "memory.captured",
        count: records.length,
      },
    })
    return records
  }

  export async function search(
    input: Memory.SearchInput & { adapter?: MemoryAdapter.Info; reranker?: MemoryReranker.Info },
  ) {
    const session = input.sessionID ? await Session.get(input.sessionID) : undefined
    const records = pick({
      query: input.query,
      limit: input.limit,
      records: (await all()).filter(
        (memory) => visible({ session, memory }) && topics({ memory, topics: input.topics }),
      ),
    })
    const adapter = input.adapter ?? new MemoryAdapter.Local()
    await adapter.upsert(MemoryAdapter.entries(records))
    const hits = await adapter.search({ query: input.query, limit: input.limit ? input.limit * 4 : 40 })
    const by = new Map(records.map((memory) => [memory.id, memory]))
    const found = hits.flatMap((hit) => {
      const memory = by.get(hit.id)
      return memory ? [memory] : []
    })
    const ranked = await MemoryReranker.select({ query: input.query, memories: found, reranker: input.reranker })
    return ranked.slice(0, input.limit ?? 10).map((item) => ({
      memory: item.memory,
      score: item.score,
      source: item.memory.source,
    }))
  }
}
