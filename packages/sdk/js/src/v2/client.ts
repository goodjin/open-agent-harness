export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

type Fetch = typeof fetch & { preconnect?: unknown }

export function createOpencodeClient(config?: Config & { directory?: string }) {
  if (!config?.fetch) {
    const customFetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (input instanceof Request) {
          ;(input as Request & { timeout?: boolean }).timeout = false
        }
        return fetch(input, init)
      },
      { preconnect: (fetch as Fetch).preconnect },
    )
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(config.directory)
    const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodedDirectory,
    }
  }

  const client = createClient(config)
  return new OpencodeClient({ client })
}
