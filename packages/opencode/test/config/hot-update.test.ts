import { afterEach, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Provider } from "../../src/provider/provider"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

let prior = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = prior
  Config.global.reset()
  await Instance.disposeAll()
})

function config(concurrency: number) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      hotprovider: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://example.invalid/v1",
        name: "Hot Provider",
        options: {
          apiKey: "test",
        },
        models: {
          hotmodel: {
            name: "Hot Model",
            concurrency,
            limit: {
              context: 1000,
              output: 100,
            },
          },
        },
      },
    },
  }
}

test("global model config update refreshes providers without interrupting running sessions", async () => {
  await using root = await tmpdir()
  await using dir = await tmpdir()
  prior = Global.Path.config
  ;(Global.Path as { config: string }).config = root.path
  Config.global.reset()
  await fs.writeFile(path.join(root.path, "opencode.json"), JSON.stringify(config(1)))

  const sid = SessionID.make("ses_hot_model_config")
  await Instance.provide({
    directory: dir.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers.hotprovider?.models.hotmodel?.concurrency).toBe(1)
      SessionStatus.set(sid, { type: "running" })
    },
  })

  const app = Server.Default()
  const res = await app.request("/global/config", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(config(3)),
  })

  expect(res.status).toBe(200)

  await Instance.provide({
    directory: dir.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers.hotprovider?.models.hotmodel?.concurrency).toBe(3)
      expect(SessionStatus.get(sid)).toEqual({ type: "running" })
    },
  })
})
