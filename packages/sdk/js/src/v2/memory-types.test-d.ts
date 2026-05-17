import type { MemorySearchData } from "./gen/types.gen.js"
import type { OpencodeClient } from "./gen/sdk.gen.js"

declare const client: OpencodeClient

const search: MemorySearchData = {
  url: "/memory/search",
  body: {
    query: "qdrant",
  },
}

void search

client.memory.search({
  memorySearchInput: {
    query: "qdrant",
  },
})

// @ts-expect-error memory search requires a JSON body
const bad: MemorySearchData = { url: "/memory/search" }

// @ts-expect-error memory search requires flat body parameters
client.memory.search()

// @ts-expect-error memory search requires query
client.memory.search({ memorySearchInput: {} })

void bad
