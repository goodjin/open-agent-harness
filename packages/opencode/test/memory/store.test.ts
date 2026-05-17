import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Session } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Memory, MemoryChunk, MemoryReranker, MemoryStore } from "../../src/memory"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { ProjectID } from "../../src/project/schema"

async function text(input: { sessionID: Session.Info["id"]; text: string; agent?: string }) {
  const user = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.sessionID,
    agent: input.agent ?? "default",
    model: {
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    },
    time: {
      created: Date.now(),
    },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: input.sessionID,
    parentID: user.id,
    mode: "default",
    agent: input.agent ?? "default",
    path: {
      cwd: path.dirname(import.meta.path),
      root: path.dirname(import.meta.path),
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    time: {
      created: Date.now(),
    },
    finish: "stop",
  }
  await Session.updateMessage(assistant)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "text",
    text: `Noted: ${input.text}`,
  })
  return input.sessionID
}

describe("memory store", () => {
  test("writes and reads session-level summaries by session", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            await text({ sessionID: session.id, text: "Use Qdrant for durable memory retrieval." })
            await MemoryStore.capture({ sessionID: session.id })

            const memories = await MemoryStore.bySession(session.id)
            expect(memories.some((memory) => memory.kind === "session")).toBe(true)
            expect(memories.map((memory) => memory.source.sessionID)).toContain(session.id)
          },
        }),
    })
  })

  test("chunk policy excludes large, file, and snapshot content", async () => {
    const sessionID = SessionID.descending()
    const messageID = MessageID.ascending()
    const partID = PartID.ascending()
    const chunks = MemoryChunk.select([
      {
        info: {
          id: messageID,
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("test"),
          },
          time: {
            created: Date.now(),
          },
        },
        parts: [
          {
            id: partID,
            messageID,
            sessionID,
            type: "text",
            text: "small durable note",
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "text",
            text: "x".repeat(MemoryChunk.MAX + 1),
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "file",
            mime: "text/plain",
            filename: "large.txt",
            url: "file:///large.txt",
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "snapshot",
            snapshot: "snap",
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "tool",
            callID: "tool-short",
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "short tool output",
              title: "bash",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "text",
            text: "OPENAI_API_KEY=sk-testsecret",
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "text",
            text: "$ ls\npackage.json\nbun.lock",
          },
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "text",
            text: "INFO boot\nWARN retry\nERROR failed\nDEBUG done",
          },
        ],
      },
    ])

    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe("small durable note")
  })

  test("retrieval filters project, session, and topic", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    let keep: Session.Info["id"] | undefined
    let skip: Session.Info["id"] | undefined

    await Instance.provide({
      directory: one.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            keep = session.id
            await text({ sessionID: session.id, text: "Vector memory stores qdrant topics." })
            await MemoryStore.capture({ sessionID: session.id })
          },
        }),
    })
    await Instance.provide({
      directory: two.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            skip = session.id
            await text({ sessionID: session.id, text: "Vector memory stores qdrant topics." })
            await MemoryStore.capture({ sessionID: session.id })
          },
        }),
    })
    await Instance.provide({
      directory: one.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            if (!keep || !skip) throw new Error("missing memory sessions")
            const found = await MemoryStore.search({ query: "qdrant", topics: ["qdrant"], sessionID: keep })
            const ids = found.map((item) => item.source.sessionID)
            expect(ids).toContain(keep)
            expect(ids).not.toContain(skip)
          },
        }),
    })
  })

  test("reranker selects high relevance memory", async () => {
    const now = Date.now()
    const projectID = ProjectID.make("project")
    const sessionID = SessionID.descending()
    const memories: Memory.Record[] = [
      {
        id: Memory.ID.ascending(),
        kind: "session",
        privacy: "project",
        projectID,
        sessionID,
        text: "Authentication token refresh design",
        topics: ["auth"],
        source: { sessionID },
        time: { created: now, updated: now },
      },
      {
        id: Memory.ID.ascending(),
        kind: "session",
        privacy: "project",
        projectID,
        sessionID,
        text: "Terminal rendering details",
        topics: ["tui"],
        source: { sessionID },
        time: { created: now, updated: now },
      },
    ]
    const ranked = await MemoryReranker.select({ query: "auth token", memories })

    expect(ranked[0].memory.topics).toEqual(["auth"])
  })

  test("subagent isolation hides private child memories and allows shared ones", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const root = await Session.create({})
            const child = await Session.create({ parentID: root.id })
            await text({ sessionID: child.id, text: "Private child zinc memory." })
            await MemoryStore.capture({ sessionID: child.id })

            let found = await MemoryStore.search({ query: "zinc", sessionID: root.id })
            expect(found.map((item) => item.source.sessionID)).not.toContain(child.id)

            await MemoryStore.capture({ sessionID: child.id, privacy: "project" })
            found = await MemoryStore.search({ query: "zinc", sessionID: root.id })
            expect(found.map((item) => item.source.sessionID)).toContain(child.id)
          },
        }),
    })
  })

  test("memory search route returns ranked memories with source session ids", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const session = await Session.create({})
            await text({ sessionID: session.id, text: "Route search remembers semantic endpoint." })
            await MemoryStore.capture({ sessionID: session.id })

            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}`
            const res = await app.request(`/memory/search?${query}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: "semantic endpoint", sessionID: session.id }),
            })
            expect(res.status).toBe(200)
            const body = (await res.json()) as Memory.SearchResult[]
            expect(body[0].source.sessionID).toBe(session.id)
          },
        }),
    })
  })

  test("memory search route rejects child session context", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const root = await Session.create({})
            const child = await Session.create({ parentID: root.id })
            await text({ sessionID: child.id, text: "Private child cobalt memory." })
            await MemoryStore.capture({ sessionID: child.id })

            const app = Server.Default()
            const query = `directory=${encodeURIComponent(tmp.path)}`
            const res = await app.request(`/memory/search?${query}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: "cobalt", sessionID: child.id }),
            })

            expect(res.status).toBe(403)
          },
        }),
    })
  })

  test("memory search route isolates by directory without workspace context", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })
    await Instance.provide({
      directory: one.path,
      fn: async () => {
        const session = await Session.create({})
        await text({ sessionID: session.id, text: "Directory one amber memory." })
        await MemoryStore.capture({ sessionID: session.id })
      },
    })
    await Instance.provide({
      directory: two.path,
      fn: async () => {
        const session = await Session.create({})
        await text({ sessionID: session.id, text: "Directory two amber memory." })
        await MemoryStore.capture({ sessionID: session.id })
      },
    })

    const app = Server.Default()
    const res = await Instance.provide({
      directory: one.path,
      fn: () =>
        app.request("/memory/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "amber" }),
        }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Memory.SearchResult[]
    expect(body.map((item) => item.memory.text)).toContain("Directory one amber memory.")
    expect(body.map((item) => item.memory.text)).not.toContain("Directory two amber memory.")
    await Instance.provide({
      directory: one.path,
      fn: async () => {
        const hits = await MemoryStore.search({ query: "amber" })
        expect(hits.map((item) => item.memory.text)).not.toContain("Directory two amber memory.")
      },
    })
  })

  test("memory search indexes only bounded visible candidates", async () => {
    await using tmp = await tmpdir({ git: true })
    const space = WorkspaceID.ascending()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const now = Date.now()
            const records: Memory.Record[] = Array.from({ length: 200 }).map((_, idx) => ({
              id: Memory.ID.ascending(),
              kind: "session",
              privacy: "project",
              projectID: Instance.project.id,
              workspaceID: space,
              directory: Instance.directory,
              sessionID: SessionID.descending(),
              text: `bounded qdrant candidate ${idx}`,
              topics: ["qdrant"],
              source: { sessionID: SessionID.descending() },
              time: { created: now, updated: now },
            }))
            await MemoryStore.put(records)

            const ids: string[] = []
            const adapter = {
              async upsert(input: { id: string; text: string; vector?: number[] }[]) {
                ids.push(...input.map((item) => item.id))
              },
              async remove(input: string[]) {
                void input
              },
              async search(input: { query: string; limit?: number; vector?: number[] }) {
                void input
                return ids.map((id) => ({ id, score: 1 }))
              },
            }

            await MemoryStore.search({ query: "qdrant", limit: 5, adapter })

            expect(ids.length).toBeLessThanOrEqual(40)
          },
        }),
    })
  })

  test("generated OpenAPI includes memory search operation", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()
    const paths = spec.paths as Record<
      string,
      { post?: { operationId?: string; requestBody?: { required?: boolean } } }
    >

    expect(paths["/memory/search"]?.post?.operationId).toBe("memory.search")
    expect(paths["/memory/search"]?.post?.requestBody?.required).toBe(true)
  })
})
