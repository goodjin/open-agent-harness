import { randomUUID } from "crypto"
import z from "zod"
import { ProjectID } from "@/project/schema"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { WorkspaceID } from "@/control-plane/schema"

function id(prefix: string, given?: string) {
  if (given) {
    if (!given.startsWith(prefix + "_")) throw new Error(`ID ${given} does not start with ${prefix}_`)
    return given
  }
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 18)}`
}

export namespace Memory {
  export const ID = {
    make: (value: string) => id("mem", value),
    ascending: () => id("mem"),
    zod: z.string().startsWith("mem_"),
  }
  export type ID = z.infer<typeof ID.zod>

  export const ChunkID = {
    make: (value: string) => id("chk", value),
    ascending: () => id("chk"),
    zod: z.string().startsWith("chk_"),
  }
  export type ChunkID = z.infer<typeof ChunkID.zod>

  export const Kind = z.enum(["session", "chunk"]).meta({ ref: "MemoryKind" })
  export type Kind = z.infer<typeof Kind>

  export const Privacy = z.enum(["project", "session"]).meta({ ref: "MemoryPrivacy" })
  export type Privacy = z.infer<typeof Privacy>

  export const Source = z
    .object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod.optional(),
      partID: PartID.zod.optional(),
      agent: z.string().optional(),
    })
    .meta({ ref: "MemorySource" })
  export type Source = z.infer<typeof Source>

  const Base = z.object({
    privacy: Privacy,
    projectID: ProjectID.zod,
    workspaceID: WorkspaceID.zod.optional(),
    directory: z.string().optional(),
    sessionID: SessionID.zod,
    parentID: SessionID.zod.optional(),
    text: z.string().min(1),
    topics: z.string().array(),
    source: Source,
    vector: z.number().array().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })

  export const SessionRecord = Base.extend({
    id: ID.zod,
    kind: z.literal("session"),
  }).meta({ ref: "MemorySessionRecord" })
  export type SessionRecord = z.infer<typeof SessionRecord>

  export const Chunk = Base.extend({
    id: ChunkID.zod,
    kind: z.literal("chunk"),
  }).meta({ ref: "MemoryChunk" })
  export type Chunk = z.infer<typeof Chunk>

  export const Record = z.discriminatedUnion("kind", [SessionRecord, Chunk]).meta({ ref: "MemoryRecord" })
  export type Record = z.infer<typeof Record>

  export const Candidate = z
    .object({
      summary: z.string(),
      topics: z.string().array(),
    })
    .meta({ ref: "MemoryCandidate" })
  export type Candidate = z.infer<typeof Candidate>

  export const SearchInput = z
    .object({
      query: z.string().min(1),
      sessionID: SessionID.zod.optional(),
      topics: z.string().array().optional(),
      limit: z.number().int().positive().max(50).optional(),
    })
    .meta({ ref: "MemorySearchInput" })
  export type SearchInput = z.infer<typeof SearchInput>

  export const SearchResult = z
    .object({
      memory: Record,
      score: z.number(),
      source: Source,
    })
    .meta({ ref: "MemorySearchResult" })
  export type SearchResult = z.infer<typeof SearchResult>
}
